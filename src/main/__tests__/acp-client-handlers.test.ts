import { describe, expect, it, vi } from "vitest";
import { GrokAcpClient } from "../acp-client.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Drive the shipped GrokAcpClient.handleLine / respond path without a live grok binary.
 * We stub stdin writes and feed agent→client requests as if they came from stdout.
 */
describe("GrokAcpClient client-request handling (shipped class)", () => {
  it("answers fs/read_text_file with a JSON-RPC response using the original numeric id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-acp-cli-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "from-disk");
    const client = new GrokAcpClient({ cwd: dir, alwaysApprove: false });

    const writes: string[] = [];
    // Inject a fake process stdin
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => {
          writes.push(s);
        },
      },
    };
    (client as unknown as { cwd: string }).cwd = dir;

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "fs/read_text_file",
        params: { path: "a.txt" },
      }),
    );

    expect(writes.length).toBe(1);
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(99);
    expect(typeof msg.id).toBe("number");
    expect(msg.result.content).toBe("from-disk");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers terminal/create so capability requests never hang", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const writes: string[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "term-1",
        method: "terminal/create",
        params: {},
      }),
    );

    expect(writes.length).toBe(1);
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe("term-1");
    expect(typeof msg.id).toBe("string");
    expect(msg.result.terminalId).toBeTruthy();
  });

  it("emits permission with numeric id and responds with same type when alwaysApprove", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: true });
    const writes: string[] = [];
    const perms: unknown[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };
    client.on("permission", (p) => perms.push(p));

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "s",
          toolCall: { title: "run", kind: "execute" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
        },
      }),
    );

    expect(perms.length).toBe(1);
    expect((perms[0] as { id: unknown }).id).toBe(7);
    expect(typeof (perms[0] as { id: unknown }).id).toBe("number");
    expect(writes.length).toBe(1);
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(7);
    expect(typeof msg.id).toBe("number");
    expect(msg.result.outcome.optionId).toBe("allow-once");
  });

  it("manual respond() preserves id type for UI approve path", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const writes: string[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };

    // Simulate UI calling respond with permission.id from parser
    client.respond(42, {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(42);
    expect(typeof msg.id).toBe("number");
  });
});
