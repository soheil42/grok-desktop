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

  it("acknowledges terminal/create without hanging", () => {
    const r = handleAgentClientRequest("terminal/create", {}, { cwd: process.cwd() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.result as { terminalId: string }).terminalId).toMatch(/^term-/);
    }
  });

  it("returns method-not-found for unknown methods", () => {
    const r = handleAgentClientRequest("unknown/thing", {}, { cwd: process.cwd() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(-32601);
  });
});
