/**
 * Handlers for ACP *client* methods the agent may invoke after we advertise
 * clientCapabilities (fs + terminal). Pure enough for unit tests.
 */
import fs from "node:fs";
import path from "node:path";

export type ClientRequestResult =
  | { ok: true; result: unknown }
  | { ok: false; message: string; code?: number };

function resolveSafePath(cwd: string, filePath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.join(cwd, filePath));
  return resolved;
}

/**
 * Handle an agent→client JSON-RPC request for advertised capabilities.
 * Returns a result object or an error; caller sends the JSON-RPC response.
 */
export function handleAgentClientRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { cwd: string },
): ClientRequestResult {
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
      // ACP commonly expects { content: string } or { text: string }
      return { ok: true, result: { content, text: content, path: abs } };
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
      return { ok: true, result: { ok: true, path: abs } };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        code: -32000,
      };
    }
  }

  // --- Terminal (minimal fulfillment so requests never hang) ---
  if (
    m === "terminal/create" ||
    m === "terminal/new" ||
    m === "createTerminal" ||
    m.startsWith("terminal/")
  ) {
    // We don't run a real PTY here; acknowledge so the agent can continue.
    // Desktop UI can surface a note later; hanging is worse than a stub.
    if (m === "terminal/create" || m === "terminal/new" || m === "createTerminal") {
      const id = `term-${Date.now()}`;
      return {
        ok: true,
        result: {
          terminalId: id,
          id,
          // Indicate limited support
          supported: false,
          message: "Grok Desktop acknowledges terminal requests without a PTY host.",
        },
      };
    }
    if (m === "terminal/output" || m === "terminal/wait_for_exit" || m === "terminal/kill") {
      return {
        ok: true,
        result: {
          output: "",
          exitCode: 0,
          message: "No active terminal host in Grok Desktop client.",
        },
      };
    }
    return {
      ok: true,
      result: { ok: true, message: `Unhandled terminal method acknowledged: ${m}` },
    };
  }

  // Unknown client method — return explicit method-not-found so agent does not hang
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
