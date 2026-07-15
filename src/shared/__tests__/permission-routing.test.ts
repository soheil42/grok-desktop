import { describe, expect, it } from "vitest";
import { parseJsonRpcLine } from "../acp-parser.js";
import { preserveJsonRpcId, type PermissionRequest } from "../types.js";

/**
 * Mirrors the shipped store logic for resolving which thread owns a permission.
 * Kept as a pure function test of the same rule used in store.respondPermission.
 */
function resolvePermissionThreadId(
  permission: PermissionRequest | null,
  activeThreadId: string | null,
): string | null {
  if (!permission) return null;
  return permission.threadId || activeThreadId;
}

/**
 * Build the JSON-RPC respond payload the way main IPC does.
 */
function buildPermissionRespondMessage(
  requestId: string | number,
  optionId: string,
): { jsonrpc: string; id: string | number; result: unknown } {
  return {
    jsonrpc: "2.0",
    id: preserveJsonRpcId(requestId),
    result: { outcome: { outcome: "selected", optionId } },
  };
}

describe("permission thread routing", () => {
  it("uses permission.threadId even when activeThreadId differs", () => {
    const perm: PermissionRequest = {
      id: 7,
      threadId: "thread-background",
      sessionId: "s",
      title: "Allow",
      description: "x",
      options: [],
      raw: {},
    };
    expect(resolvePermissionThreadId(perm, "thread-active")).toBe("thread-background");
  });

  it("falls back to activeThreadId when permission has no threadId", () => {
    const perm: PermissionRequest = {
      id: 7,
      sessionId: "s",
      title: "Allow",
      description: "x",
      options: [],
      raw: {},
    };
    expect(resolvePermissionThreadId(perm, "thread-active")).toBe("thread-active");
  });
});

describe("permission respond id wire format", () => {
  it("respond message keeps numeric id from parsed permission", () => {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { title: "bash", kind: "execute" },
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      },
    });
    const parsed = parseJsonRpcLine(line);
    const perm = parsed.updates.permission!;
    expect(typeof perm.id).toBe("number");

    // Stamp thread like main process does
    const stamped: PermissionRequest = { ...perm, threadId: "t-1" };
    const msg = buildPermissionRespondMessage(stamped.id, "allow-once");
    expect(msg.id).toBe(42);
    expect(typeof msg.id).toBe("number");
    // Agent would reject if we sent "42"
    expect(JSON.parse(JSON.stringify(msg)).id).toBe(42);
  });
});
