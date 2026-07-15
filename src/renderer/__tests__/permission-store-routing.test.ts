import { describe, expect, it } from "vitest";
import { resolvePermissionThreadId } from "../store";
import type { PermissionRequest } from "@shared/types";

describe("resolvePermissionThreadId (shipped store export)", () => {
  it("prefers permission.threadId over active thread", () => {
    const perm: PermissionRequest = {
      id: 42,
      threadId: "bg-thread",
      sessionId: "s",
      title: "Allow shell",
      description: "ls",
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      raw: {},
    };
    expect(resolvePermissionThreadId(perm, "ui-active-thread")).toBe("bg-thread");
  });

  it("falls back to activeThreadId", () => {
    const perm: PermissionRequest = {
      id: "req-1",
      sessionId: "s",
      title: "Allow",
      description: "x",
      options: [],
      raw: {},
    };
    expect(resolvePermissionThreadId(perm, "ui-active-thread")).toBe("ui-active-thread");
  });

  it("returns null without permission", () => {
    expect(resolvePermissionThreadId(null, "x")).toBeNull();
  });
});
