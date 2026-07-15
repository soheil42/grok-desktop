import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { parseJsonRpcLine } from "../shared/acp-parser.js";
import {
  handleAgentClientRequest,
  isAgentToClientCapabilityMethod,
} from "../shared/client-requests.js";
import type { PlanApprovalRequest } from "../shared/plan-approval.js";
import type { UserQuestionRequest } from "../shared/user-questions.js";
import { preserveJsonRpcId } from "../shared/types.js";
import type { PermissionRequest, StreamItem } from "../shared/types.js";

export type AcpClientEvents = {
  update: (payload: {
    sessionId: string;
    items: StreamItem[];
    permission?: PermissionRequest | null;
    planApproval?: PlanApprovalRequest | null;
    userQuestions?: UserQuestionRequest | null;
  }) => void;
  permission: (req: PermissionRequest) => void;
  planApproval: (req: PlanApprovalRequest) => void;
  userQuestions: (req: UserQuestionRequest) => void;
  error: (err: Error) => void;
  exit: (code: number | null) => void;
  log: (line: string) => void;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * Thin JSON-RPC client over `grok agent stdio`.
 * Owns the process and answers advertised client capability requests (fs/terminal).
 */
export class GrokAcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private initialized = false;
  private sessionId: string | null = null;
  private cwd: string;
  private binary: string;
  private alwaysApprove: boolean;
  private stderrBuf = "";

  constructor(opts: { cwd: string; binary?: string; alwaysApprove?: boolean }) {
    super();
    this.cwd = opts.cwd;
    this.binary = opts.binary || process.env.GROK_BINARY || "grok";
    this.alwaysApprove = opts.alwaysApprove ?? false;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return this.proc != null && this.proc.exitCode == null;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    // Flags belong on `grok agent`, before the transport subcommand.
    const args = ["agent"];
    if (this.alwaysApprove) args.push("--always-approve");
    args.push("stdio");

    this.proc = spawn(this.binary, args, {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (buf: Buffer) => {
      this.stderrBuf += buf.toString("utf8");
      const lines = this.stderrBuf.split("\n");
      this.stderrBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.emit("log", line);
      }
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    this.proc.on("exit", (code) => {
      this.proc = null;
      this.rl = null;
      this.initialized = false;
      for (const [, p] of this.pending) {
        p.reject(new Error(`grok agent exited (${code})`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });

    await this.initialize();
  }

  /**
   * Process one stdout line. Exported for tests via handleLine.
   */
  handleLine(line: string): void {
    this.onLine(line);
  }

  private onLine(line: string): void {
    const parsed = parseJsonRpcLine(line);

    if (parsed.kind === "response") {
      // Our outbound requests always use numeric ids.
      const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (parsed.error) {
          const errObj = parsed.error as { message?: string };
          pending.reject(new Error(errObj.message || JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result);
        }
      }
      return;
    }

    if (parsed.kind === "request" && parsed.method) {
      const rpcId =
        parsed.id !== undefined ? preserveJsonRpcId(parsed.id) : undefined;

      // Advertised fs / terminal capabilities — always answer so the agent never hangs.
      if (isAgentToClientCapabilityMethod(parsed.method) && rpcId !== undefined) {
        const outcome = handleAgentClientRequest(
          parsed.method,
          (parsed.params as Record<string, unknown>) || {},
          { cwd: this.cwd },
        );
        if (outcome.ok) {
          this.respond(rpcId, outcome.result);
        } else {
          this.respondError(rpcId, outcome.message);
        }
        this.emit("log", `client-request ${parsed.method} → ${outcome.ok ? "ok" : "error"}`);
        return;
      }

      if (parsed.updates.planApproval) {
        // Plan exit/enter must never auto-approve — user must review.
        this.emit("planApproval", parsed.updates.planApproval);
      } else if (parsed.updates.userQuestions) {
        this.emit("userQuestions", parsed.updates.userQuestions);
      } else if (parsed.updates.permission) {
        this.emit("permission", parsed.updates.permission);
      }
      if (
        parsed.updates.items.length ||
        parsed.updates.permission ||
        parsed.updates.planApproval ||
        parsed.updates.userQuestions
      ) {
        this.emit("update", {
          sessionId: this.sessionId ?? "",
          items: parsed.updates.items,
          permission: parsed.updates.permission,
          planApproval: parsed.updates.planApproval,
          userQuestions: parsed.updates.userQuestions,
        });
      }

      // Auto-respond tool permissions when alwaysApprove.
      // Never auto-respond plan exit/enter or ask_user_question *forms*
      // (those need the modal). Exception: bare ask_user_question permission
      // without questions is auto-allowed like CLI (wait_ms:0) so the tool can
      // proceed to x.ai/ask_user_question — handled below via emit.
      if (
        rpcId !== undefined &&
        (parsed.method.includes("permission") ||
          parsed.method === "session/request_permission")
      ) {
        const isAsk =
          Boolean(parsed.updates.userQuestions) ||
          /ask[_\s-]?user|ask\s+\d+\s+question/i.test(
            JSON.stringify(parsed.params ?? {}).slice(0, 500),
          );
        const hasQuestions =
          (parsed.updates.userQuestions?.questions.length ?? 0) > 0;

        // CLI: permission for ask_user_question is auto-allowed; the form is the ext_method.
        if (isAsk && !hasQuestions) {
          this.respond(rpcId, {
            outcome: { outcome: "selected", optionId: "allow-once" },
          });
          this.emit("log", "auto-allow ask_user_question permission (CLI parity)");
        } else if (
          this.alwaysApprove &&
          !parsed.updates.planApproval &&
          !parsed.updates.userQuestions
        ) {
          this.respond(rpcId, {
            outcome: {
              outcome: "selected",
              optionId: "allow-once",
            },
          });
        }
      }

      // Log interactive requests for debugging stuck tools
      if (
        parsed.method &&
        (parsed.method.includes("ask_user") ||
          parsed.method.includes("exit_plan") ||
          parsed.method.includes("permission"))
      ) {
        this.emit(
          "log",
          `agent→client ${parsed.method} id=${String(parsed.id)} plan=${Boolean(parsed.updates.planApproval)} ask=${Boolean(parsed.updates.userQuestions)} qs=${parsed.updates.userQuestions?.questions.length ?? 0}`,
        );
      }
      return;
    }

    if (
      parsed.kind === "notification" &&
      (parsed.updates.items.length ||
        parsed.updates.planApproval ||
        parsed.updates.userQuestions)
    ) {
      const params = parsed.params as { sessionId?: string } | undefined;
      if (parsed.updates.planApproval) {
        this.emit("planApproval", parsed.updates.planApproval);
      }
      if (parsed.updates.userQuestions) {
        this.emit("userQuestions", parsed.updates.userQuestions);
      }
      this.emit("update", {
        sessionId: params?.sessionId ?? this.sessionId ?? "",
        items: parsed.updates.items,
        permission: parsed.updates.permission,
        planApproval: parsed.updates.planApproval,
        userQuestions: parsed.updates.userQuestions,
      });
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error("ACP process is not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`ACP request timeout: ${method}`));
        }
      }, 120_000);
    });
  }

  /**
   * Respond to an agent→client request. Id type must match the agent's request.
   */
  respond(id: string | number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: preserveJsonRpcId(id), result });
  }

  respondError(id: string | number, message: string, code = -32000): void {
    this.send({
      jsonrpc: "2.0",
      id: preserveJsonRpcId(id),
      error: { code, message },
    });
  }

  private async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "grok-desktop",
        version: "1.0.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      // Advertise interactive question UI so Grok sends x.ai/ask_user_question
      // instead of parking / hanging the tool (see CLI _meta.askUserQuestion: bool).
      _meta: {
        askUserQuestion: true,
        "x.ai/ask_user_question": true,
        "x.ai/exit_plan_mode": true,
      },
    })) as Record<string, unknown>;
    this.initialized = true;
    this.emit("log", `ACP initialized: ${JSON.stringify(result?.protocolVersion ?? result)}`);
  }

  async newSession(cwd?: string): Promise<string> {
    if (!this.initialized) await this.start();
    const result = (await this.request("session/new", {
      cwd: cwd || this.cwd,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error("session/new did not return sessionId");
    }
    this.sessionId = result.sessionId;
    this.cwd = cwd || this.cwd;
    return this.sessionId;
  }

  async loadSession(sessionId: string, cwd?: string): Promise<string> {
    if (!this.initialized) await this.start();
    await this.request("session/load", {
      sessionId,
      cwd: cwd || this.cwd,
      mcpServers: [],
    });
    this.sessionId = sessionId;
    if (cwd) this.cwd = cwd;
    return sessionId;
  }

  async prompt(text: string, sessionId?: string): Promise<unknown> {
    const sid = sessionId || this.sessionId;
    if (!sid) throw new Error("No active session");
    return this.request("session/prompt", {
      sessionId: sid,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(sessionId?: string): Promise<void> {
    const sid = sessionId || this.sessionId;
    if (!sid) return;
    try {
      await this.request("session/cancel", { sessionId: sid });
    } catch {
      // best-effort
    }
  }

  async dispose(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.proc = null;
  }
}

/**
 * Headless bootstrap used by verify scripts and tests (no Electron).
 * This is the shipped integration entry — smoke tests must call this, not reimplement RPC.
 */
export async function bootstrapAcpSmoke(opts: {
  binary?: string;
  cwd: string;
  prompt?: string;
  timeoutMs?: number;
  alwaysApprove?: boolean;
}): Promise<{
  sessionId: string;
  lines: string[];
  items: StreamItem[];
  permissions: PermissionRequest[];
  client: GrokAcpClient;
}> {
  const client = new GrokAcpClient({
    cwd: opts.cwd,
    binary: opts.binary,
    alwaysApprove: opts.alwaysApprove ?? true,
  });
  const lines: string[] = [];
  const items: StreamItem[] = [];
  const permissions: PermissionRequest[] = [];

  client.on("log", (l: string) => lines.push(l));
  client.on("update", (u: { items: StreamItem[]; permission?: PermissionRequest | null }) => {
    items.push(...u.items);
    lines.push(JSON.stringify({ type: "update", count: u.items.length }));
  });
  client.on("permission", (req: PermissionRequest) => {
    permissions.push(req);
    lines.push(JSON.stringify({ type: "permission", id: req.id, idType: typeof req.id }));
  });

  await client.start();
  const sessionId = await client.newSession(opts.cwd);

  if (opts.prompt) {
    const promptPromise = client.prompt(opts.prompt, sessionId);
    const timeout = opts.timeoutMs ?? 90_000;
    await Promise.race([
      promptPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("prompt timeout")), timeout)),
    ]).catch((e) => {
      if (items.length === 0 && permissions.length === 0) throw e;
    });
  }

  return { sessionId, lines, items, permissions, client };
}
