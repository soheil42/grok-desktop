import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetParserIds,
  parseSessionUpdate,
  parseJsonRpcLine,
  coalesceStreamItems,
} from "../acp-parser.js";

beforeEach(() => {
  __resetParserIds();
});

describe("parseSessionUpdate", () => {
  it("parses agent text chunks into agent_text stream items", () => {
    const batch = parseSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello from Grok" },
    });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].kind).toBe("agent_text");
    expect(batch.items[0].text).toBe("Hello from Grok");
  });

  it("parses thought chunks", () => {
    const batch = parseSessionUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { text: "Considering worktrees" },
    });
    expect(batch.items[0].kind).toBe("thought");
    expect(batch.items[0].text).toContain("worktrees");
  });

  it("parses tool_call and tool_call_update with status", () => {
    const call = parseSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "abc",
      title: "search_replace",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "a.ts" },
    });
    expect(call.items[0].kind).toBe("tool_call");
    expect(call.items[0].toolCallId).toBe("abc");
    expect(call.items[0].status).toBe("in_progress");

    const update = parseSessionUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "abc",
      status: "completed",
      rawOutput: "ok",
    });
    expect(update.items[0].kind).toBe("tool_result");
    expect(update.items[0].output).toBe("ok");
  });

  it("unwraps nested update payloads from Grok wrappers", () => {
    const batch = parseSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Nested" },
      },
    } as never);
    expect(batch.items[0].text).toBe("Nested");
  });

  it("extracts unified diffs when present in output", () => {
    const batch = parseSessionUpdate({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n",
    });
    expect(batch.items[0].diffs?.length).toBeGreaterThan(0);
    expect(batch.items[0].diffs?.[0].unified).toContain("@@");
  });
});

describe("parseJsonRpcLine", () => {
  it("parses session/update notifications into stream items", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: "streamed" },
        },
      },
    });
    const parsed = parseJsonRpcLine(line);
    expect(parsed.kind).toBe("notification");
    expect(parsed.updates.items[0].text).toBe("streamed");
  });

  it("parses permission requests with options and preserves numeric JSON-RPC id", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { title: "run_terminal_command", kind: "execute", rawInput: { command: "ls" } },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    const parsed = parseJsonRpcLine(line);
    expect(parsed.kind).toBe("request");
    expect(parsed.updates.permission?.title).toContain("run_terminal");
    expect(parsed.updates.permission?.options.length).toBe(2);
    expect(parsed.updates.items[0].kind).toBe("permission");
    // Critical: id must remain a number (not "42") so agent pending map matches.
    expect(parsed.updates.permission?.id).toBe(42);
    expect(typeof parsed.updates.permission?.id).toBe("number");
    expect(parsed.id).toBe(42);
  });

  it("preserves string JSON-RPC ids on permission requests", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-abc",
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { title: "edit", kind: "edit" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      },
    });
    const parsed = parseJsonRpcLine(line);
    expect(parsed.updates.permission?.id).toBe("req-abc");
    expect(typeof parsed.updates.permission?.id).toBe("string");
  });

  it("returns unknown for invalid JSON without throwing", () => {
    const parsed = parseJsonRpcLine("not-json");
    expect(parsed.kind).toBe("unknown");
    expect(parsed.updates.items).toEqual([]);
  });
});

describe("coalesceStreamItems", () => {
  it("merges consecutive agent_text chunks", () => {
    const merged = coalesceStreamItems([
      { id: "1", kind: "agent_text", timestamp: 1, text: "Hel" },
      { id: "2", kind: "agent_text", timestamp: 2, text: "lo" },
      { id: "3", kind: "thought", timestamp: 3, text: "hmm" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("Hello");
    expect(merged[1].kind).toBe("thought");
  });

  it("merges tool updates with same toolCallId", () => {
    const merged = coalesceStreamItems([
      {
        id: "1",
        kind: "tool_call",
        timestamp: 1,
        toolCallId: "t1",
        status: "pending",
        title: "edit",
      },
      {
        id: "2",
        kind: "tool_result",
        timestamp: 2,
        toolCallId: "t1",
        status: "completed",
        output: "done",
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe("completed");
    expect(merged[0].output).toBe("done");
  });
});
