import { describe, expect, it } from "vitest";
import { filterVisibleStreamItems } from "../stream-filter.js";
import type { StreamItem } from "../types.js";

function item(partial: Partial<StreamItem> & Pick<StreamItem, "kind">): StreamItem {
  return {
    id: partial.id || "x",
    timestamp: 1,
    ...partial,
  };
}

describe("filterVisibleStreamItems", () => {
  it("keeps user and agent text", () => {
    const out = filterVisibleStreamItems([
      item({ kind: "user", text: "hi" }),
      item({ kind: "agent_text", text: "hello" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("drops empty agent cards and system noise", () => {
    const out = filterVisibleStreamItems([
      item({ kind: "agent_text", text: "" }),
      item({ kind: "system", title: "hook_execution", text: "hook_execution" }),
      item({ kind: "system", title: "available_commands_update", text: "x" }),
      item({ kind: "user", text: "real" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("real");
  });

  it("keeps tool calls with titles", () => {
    const out = filterVisibleStreamItems([
      item({ kind: "tool_call", title: "read_file", status: "completed" }),
    ]);
    expect(out).toHaveLength(1);
  });
});
