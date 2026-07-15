import { describe, expect, it } from "vitest";
import { filterVisibleStreamItems, isNoiseToolCall } from "../stream-filter.js";
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

  it("drops noise tool chips (Tool / updating plan)", () => {
    expect(isNoiseToolCall(item({ kind: "tool_call", title: "Tool" }))).toBe(true);
    expect(
      isNoiseToolCall(item({ kind: "tool_result", title: "Updating plan" })),
    ).toBe(true);
    expect(
      isNoiseToolCall(
        item({
          kind: "tool_result",
          title: "Edit `index.html`",
          status: "completed",
          input: { path: "index.html" },
        }),
      ),
    ).toBe(false);

    const out = filterVisibleStreamItems([
      item({ kind: "tool_call", title: "Tool" }),
      item({ kind: "tool_result", title: "Updating plan" }),
      item({
        kind: "tool_result",
        title: "Edit `a.ts`",
        input: { path: "a.ts" },
        status: "completed",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toMatch(/Edit/);
  });
});
