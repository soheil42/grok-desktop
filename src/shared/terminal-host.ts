/**
 * Real process host for ACP terminal/* client methods.
 * Spec: https://agentclientprotocol.com/protocol/v1/schema#terminal-create
 */
import { spawn, type ChildProcess } from "node:child_process";
import { pathWithGrokBin } from "./grok-binary.js";

export type TerminalExitStatus = {
  exitCode: number | null;
  signal: string | null;
};

type TerminalRecord = {
  id: string;
  proc: ChildProcess | null;
  output: string;
  truncated: boolean;
  byteLimit: number;
  exitStatus: TerminalExitStatus | null;
  waiters: Array<(s: TerminalExitStatus) => void>;
  killed: boolean;
};

const terminals = new Map<string, TerminalRecord>();
let seq = 0;

function appendOutput(rec: TerminalRecord, chunk: string): void {
  rec.output += chunk;
  if (rec.byteLimit > 0 && Buffer.byteLength(rec.output, "utf8") > rec.byteLimit) {
    // Truncate from the beginning on a character boundary
    let buf = Buffer.from(rec.output, "utf8");
    buf = buf.subarray(buf.length - rec.byteLimit);
    // Avoid splitting a multi-byte char
    while (buf.length && (buf[0] & 0xc0) === 0x80) {
      buf = buf.subarray(1);
    }
    rec.output = buf.toString("utf8");
    rec.truncated = true;
  }
}

function finish(rec: TerminalRecord, status: TerminalExitStatus): void {
  if (rec.exitStatus) return;
  rec.exitStatus = status;
  for (const w of rec.waiters) w(status);
  rec.waiters = [];
}

export function createTerminal(params: {
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Array<{ name?: string; value?: string } | Record<string, string>>;
  outputByteLimit?: number | null;
  sessionCwd: string;
}): { terminalId: string } {
  const id = `term-${Date.now()}-${++seq}`;
  const cwd =
    params.cwd && String(params.cwd).trim()
      ? String(params.cwd)
      : params.sessionCwd;
  const byteLimit =
    typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
      ? params.outputByteLimit
      : 1024 * 1024; // 1 MiB default

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathWithGrokBin(process.env),
  };
  if (Array.isArray(params.env)) {
    for (const entry of params.env) {
      if (!entry || typeof entry !== "object") continue;
      if ("name" in entry && entry.name != null) {
        env[String(entry.name)] = String(
          (entry as { value?: string }).value ?? "",
        );
      } else {
        for (const [k, v] of Object.entries(entry)) {
          if (k === "name" || k === "value") continue;
          env[k] = String(v);
        }
      }
    }
  }

  const command = String(params.command || "");
  const args = Array.isArray(params.args) ? params.args.map(String) : [];

  // Prefer shell -lc when agent only passes a command string (Bash tool path)
  let proc: ChildProcess;
  if (args.length === 0 && command.includes(" ")) {
    proc = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else if (args.length === 0) {
    proc = spawn(command, [], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } else {
    proc = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  }

  const rec: TerminalRecord = {
    id,
    proc,
    output: "",
    truncated: false,
    byteLimit,
    exitStatus: null,
    waiters: [],
    killed: false,
  };
  terminals.set(id, rec);

  proc.stdout?.on("data", (buf: Buffer) => appendOutput(rec, buf.toString("utf8")));
  proc.stderr?.on("data", (buf: Buffer) => appendOutput(rec, buf.toString("utf8")));
  proc.on("error", (err) => {
    appendOutput(rec, `\n[spawn error] ${err.message}\n`);
    finish(rec, { exitCode: 127, signal: null });
    rec.proc = null;
  });
  proc.on("close", (code, signal) => {
    finish(rec, {
      exitCode: typeof code === "number" ? code : null,
      signal: signal ? String(signal) : null,
    });
    rec.proc = null;
  });

  return { terminalId: id };
}

export function terminalOutput(terminalId: string): {
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
} {
  const rec = terminals.get(terminalId);
  if (!rec) {
    return {
      output: "",
      truncated: false,
      exitStatus: { exitCode: 1, signal: null },
    };
  }
  return {
    output: rec.output,
    truncated: rec.truncated,
    exitStatus: rec.exitStatus,
  };
}

export function waitForTerminalExit(
  terminalId: string,
): Promise<{ exitCode: number | null; signal: string | null }> {
  const rec = terminals.get(terminalId);
  if (!rec) {
    return Promise.resolve({ exitCode: 1, signal: null });
  }
  if (rec.exitStatus) {
    return Promise.resolve({
      exitCode: rec.exitStatus.exitCode,
      signal: rec.exitStatus.signal,
    });
  }
  return new Promise((resolve) => {
    rec.waiters.push((s) =>
      resolve({ exitCode: s.exitCode, signal: s.signal }),
    );
  });
}

export function killTerminal(terminalId: string): void {
  const rec = terminals.get(terminalId);
  if (!rec || rec.killed) return;
  rec.killed = true;
  try {
    rec.proc?.kill("SIGTERM");
    setTimeout(() => {
      try {
        rec.proc?.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 1500);
  } catch {
    // ignore
  }
}

export function releaseTerminal(terminalId: string): void {
  killTerminal(terminalId);
  const rec = terminals.get(terminalId);
  if (rec && !rec.exitStatus) {
    finish(rec, { exitCode: null, signal: "SIGTERM" });
  }
  terminals.delete(terminalId);
}

/** Test helper */
export function __clearTerminalsForTests(): void {
  for (const id of [...terminals.keys()]) {
    releaseTerminal(id);
  }
  terminals.clear();
}
