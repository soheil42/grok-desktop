/**
 * Handlers for ACP *client* methods the agent may invoke after we advertise
 * clientCapabilities (fs + terminal).
 *
 * Terminal responses MUST match ACP schema exactly — wrong shapes cause
 * "failed to deserialize response" and break run_terminal_command.
 * Spec: https://agentclientprotocol.com/protocol/v1/schema
 */
import fs from "node:fs";
import path from "node:path";
import {
  createTerminal,
  killTerminal,
  releaseTerminal,
  terminalOutput,
  waitForTerminalExit,
} from "./terminal-host.js";

export type ClientRequestResult =
  | { ok: true; result: unknown }
  | { ok: false; message: string; code?: number };

export type AsyncClientRequestResult = Promise<ClientRequestResult>;

function resolveSafePath(cwd: string, filePath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(cwd, filePath));
  return resolved;
}

function isTerminalMethod(m: string): boolean {
  return (
    m.startsWith("terminal/") ||
    m === "createTerminal" ||
    m === "terminal/create" ||
    m === "terminal/output" ||
    m === "terminal/wait_for_exit" ||
    m === "terminal/kill" ||
    m === "terminal/release"
  );
}

/**
 * Handle agent→client request. Terminal wait is async.
 */
export async function handleAgentClientRequestAsync(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { cwd: string },
): Promise<ClientRequestResult> {
  const p = params ?? {};
  const m = method.replace(/^\/+/, "");

  // --- Filesystem ---
  if (
    m === "fs/read_text_file" ||
    m === "fs/readTextFile" ||
    m === "fs/read_file" ||
    m === "readTextFile"
  ) {
    const filePath = String(p.path ?? p.uri ?? "");
    if (!filePath) return { ok: false, message: "fs read: missing path", code: -32602 };
    try {
      const abs = resolveSafePath(opts.cwd, filePath);
      const content = fs.readFileSync(abs, "utf8");
      // ACP ReadTextFileResponse: { content: string }
      return { ok: true, result: { content } };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  if (
    m === "fs/write_text_file" ||
    m === "fs/writeTextFile" ||
    m === "fs/write_file" ||
    m === "writeTextFile"
  ) {
    const filePath = String(p.path ?? p.uri ?? "");
    const content = p.content != null ? String(p.content) : p.text != null ? String(p.text) : null;
    if (!filePath) return { ok: false, message: "fs write: missing path", code: -32602 };
    if (content == null) return { ok: false, message: "fs write: missing content", code: -32602 };
    try {
      const abs = resolveSafePath(opts.cwd, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      // ACP WriteTextFileResponse: empty object (+ optional _meta)
      return { ok: true, result: {} };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  // --- Terminal (real processes, strict ACP shapes) ---
  if (m === "terminal/create" || m === "createTerminal") {
    const command = String(p.command ?? "");
    if (!command) {
      return { ok: false, message: "terminal/create: missing command", code: -32602 };
    }
    try {
      const { terminalId } = createTerminal({
        command,
        args: Array.isArray(p.args) ? (p.args as string[]) : undefined,
        cwd: p.cwd != null ? String(p.cwd) : null,
        env: Array.isArray(p.env)
          ? (p.env as Array<{ name?: string; value?: string }>)
          : undefined,
        outputByteLimit:
          typeof p.outputByteLimit === "number" ? p.outputByteLimit : null,
        sessionCwd: opts.cwd,
      });
      // CreateTerminalResponse: { terminalId }
      return { ok: true, result: { terminalId } };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  if (m === "terminal/output") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/output: missing terminalId", code: -32602 };
    }
    const out = terminalOutput(terminalId);
    // TerminalOutputResponse: { output, truncated, exitStatus }
    return {
      ok: true,
      result: {
        output: out.output,
        truncated: out.truncated,
        exitStatus: out.exitStatus,
      },
    };
  }

  if (m === "terminal/wait_for_exit") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return {
        ok: false,
        message: "terminal/wait_for_exit: missing terminalId",
        code: -32602,
      };
    }
    const status = await waitForTerminalExit(terminalId);
    // WaitForTerminalExitResponse: { exitCode, signal }
    return {
      ok: true,
      result: {
        exitCode: status.exitCode,
        signal: status.signal,
      },
    };
  }

  if (m === "terminal/kill") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/kill: missing terminalId", code: -32602 };
    }
    killTerminal(terminalId);
    return { ok: true, result: {} };
  }

  if (m === "terminal/release") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/release: missing terminalId", code: -32602 };
    }
    releaseTerminal(terminalId);
    return { ok: true, result: {} };
  }

  if (isTerminalMethod(m)) {
    return {
      ok: false,
      message: `Unknown terminal method: ${method}`,
      code: -32601,
    };
  }

  return {
    ok: false,
    message: `Client method not implemented: ${method}`,
    code: -32601,
  };
}

/** Sync wrapper for unit tests / non-terminal methods. */
export function handleAgentClientRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { cwd: string },
): ClientRequestResult {
  const m = method.replace(/^\/+/, "");
  if (m === "terminal/wait_for_exit") {
    // Cannot wait synchronously — return incomplete marker for tests
    return {
      ok: false,
      message: "terminal/wait_for_exit requires async handler",
      code: -32000,
    };
  }
  // For sync tests of create/output — use deasync-free path via async with
  // immediate settle (create/output/kill/release are sync-ish).
  let settled: ClientRequestResult | null = null;
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  void handleAgentClientRequestAsync(method, params, opts).then((r) => {
    settled = r;
  });
  // Spin microtasks — create/fs finish sync in practice
  if (settled) return settled;
  // Fallback: run a limited busy-wait is bad; call the logic directly for non-wait
  // Instead re-implement: for unit tests, use handleAgentClientRequestAsync.
  // Provide best-effort for create/output/fs by calling thenables poorly...
  // Better: keep sync path for fs + sync terminal ops only.
  return handleAgentClientRequestSync(method, params, opts);
}

function handleAgentClientRequestSync(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { cwd: string },
): ClientRequestResult {
  const p = params ?? {};
  const m = method.replace(/^\/+/, "");

  if (
    m === "fs/read_text_file" ||
    m === "fs/readTextFile" ||
    m === "fs/read_file" ||
    m === "readTextFile"
  ) {
    const filePath = String(p.path ?? p.uri ?? "");
    if (!filePath) return { ok: false, message: "fs read: missing path", code: -32602 };
    try {
      const abs = resolveSafePath(opts.cwd, filePath);
      const content = fs.readFileSync(abs, "utf8");
      return { ok: true, result: { content } };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  if (
    m === "fs/write_text_file" ||
    m === "fs/writeTextFile" ||
    m === "fs/write_file" ||
    m === "writeTextFile"
  ) {
    const filePath = String(p.path ?? p.uri ?? "");
    const content = p.content != null ? String(p.content) : p.text != null ? String(p.text) : null;
    if (!filePath) return { ok: false, message: "fs write: missing path", code: -32602 };
    if (content == null) return { ok: false, message: "fs write: missing content", code: -32602 };
    try {
      const abs = resolveSafePath(opts.cwd, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      return { ok: true, result: {} };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  if (m === "terminal/create" || m === "createTerminal") {
    const command = String(p.command ?? "");
    if (!command) {
      return { ok: false, message: "terminal/create: missing command", code: -32602 };
    }
    try {
      const { terminalId } = createTerminal({
        command,
        args: Array.isArray(p.args) ? (p.args as string[]) : undefined,
        cwd: p.cwd != null ? String(p.cwd) : null,
        env: Array.isArray(p.env)
          ? (p.env as Array<{ name?: string; value?: string }>)
          : undefined,
        outputByteLimit:
          typeof p.outputByteLimit === "number" ? p.outputByteLimit : null,
        sessionCwd: opts.cwd,
      });
      return { ok: true, result: { terminalId } };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  if (m === "terminal/output") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/output: missing terminalId", code: -32602 };
    }
    const out = terminalOutput(terminalId);
    return {
      ok: true,
      result: {
        output: out.output,
        truncated: out.truncated,
        exitStatus: out.exitStatus,
      },
    };
  }

  if (m === "terminal/kill") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/kill: missing terminalId", code: -32602 };
    }
    killTerminal(terminalId);
    return { ok: true, result: {} };
  }

  if (m === "terminal/release") {
    const terminalId = String(p.terminalId ?? p.id ?? "");
    if (!terminalId) {
      return { ok: false, message: "terminal/release: missing terminalId", code: -32602 };
    }
    releaseTerminal(terminalId);
    return { ok: true, result: {} };
  }

  return {
    ok: false,
    message: `Client method not implemented: ${method}`,
    code: -32601,
  };
}

/** True when this method is a client capability request (not permission / session). */
export function isAgentToClientCapabilityMethod(method: string): boolean {
  const m = method.replace(/^\/+/, "");
  if (m.includes("permission")) return false;
  return (
    m.startsWith("fs/") ||
    m.startsWith("terminal/") ||
    m === "readTextFile" ||
    m === "writeTextFile" ||
    m === "createTerminal"
  );
}
