import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleAgentClientRequest,
  isAgentToClientCapabilityMethod,
} from "../client-requests.js";
import { preserveJsonRpcId } from "../types.js";

describe("preserveJsonRpcId", () => {
  it("keeps numbers as numbers", () => {
    expect(preserveJsonRpcId(42)).toBe(42);
    expect(typeof preserveJsonRpcId(42)).toBe("number");
  });

  it("keeps strings as strings", () => {
    expect(preserveJsonRpcId("42")).toBe("42");
    expect(typeof preserveJsonRpcId("42")).toBe("string");
  });
});

describe("isAgentToClientCapabilityMethod", () => {
  it("detects fs and terminal methods", () => {
    expect(isAgentToClientCapabilityMethod("fs/read_text_file")).toBe(true);
    expect(isAgentToClientCapabilityMethod("fs/writeTextFile")).toBe(true);
    expect(isAgentToClientCapabilityMethod("terminal/create")).toBe(true);
    expect(isAgentToClientCapabilityMethod("session/request_permission")).toBe(false);
    expect(isAgentToClientCapabilityMethod("session/update")).toBe(false);
  });
});

describe("handleAgentClientRequest", () => {
  it("reads a text file relative to cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-fs-"));
    const file = path.join(dir, "hello.txt");
    fs.writeFileSync(file, "hello-shipped");
    try {
      const r = handleAgentClientRequest(
        "fs/read_text_file",
        { path: "hello.txt" },
        { cwd: dir },
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.result as { content: string }).content).toBe("hello-shipped");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a text file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-desk-fs-w-"));
    try {
      const r = handleAgentClientRequest(
        "fs/write_text_file",
        { path: "out.txt", content: "written-by-handler" },
        { cwd: dir },
      );
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("written-by-handler");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a real terminal and returns ACP-shaped result", async () => {
    const { handleAgentClientRequestAsync } = await import("../client-requests.js");
    const { releaseTerminal } = await import("../terminal-host.js");
    const r = await handleAgentClientRequestAsync(
      "terminal/create",
      { command: "echo", args: ["hello-acp"] },
      { cwd: process.cwd() },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tid = (r.result as { terminalId: string }).terminalId;
      expect(tid).toMatch(/^term-/);
      // Strict shape: only terminalId (no extra keys required, but must have it)
      expect((r.result as { terminalId: string }).terminalId).toBeTruthy();
      const wait = await handleAgentClientRequestAsync(
        "terminal/wait_for_exit",
        { terminalId: tid },
        { cwd: process.cwd() },
      );
      expect(wait.ok).toBe(true);
      if (wait.ok) {
        expect((wait.result as { exitCode: number }).exitCode).toBe(0);
      }
      const out = await handleAgentClientRequestAsync(
        "terminal/output",
        { terminalId: tid },
        { cwd: process.cwd() },
      );
      expect(out.ok).toBe(true);
      if (out.ok) {
        const body = out.result as {
          output: string;
          truncated: boolean;
          exitStatus: { exitCode: number | null } | null;
        };
        expect(body.output).toMatch(/hello-acp/);
        expect(typeof body.truncated).toBe("boolean");
        expect(body.exitStatus?.exitCode).toBe(0);
      }
      releaseTerminal(tid);
    }
  });

  it("returns method-not-found for unknown methods", () => {
    const r = handleAgentClientRequest("unknown/thing", {}, { cwd: process.cwd() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(-32601);
  });
});
