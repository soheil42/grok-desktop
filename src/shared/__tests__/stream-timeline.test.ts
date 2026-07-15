import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  classifyTool,
  mergeToolsById,
  toolClassLabel,
} from "../stream-timeline.js";
import type { StreamItem } from "../types.js";

function item(p: Partial<StreamItem> & Pick<StreamItem, "kind" | "id">): StreamItem {
  return { timestamp: 1, ...p };
}

describe("classifyTool", () => {
  it("classifies read/edit/execute", () => {
    expect(classifyTool(item({ id: "1", kind: "tool_call", title: "Read `a.ts`" }))).toBe("read");
    expect(classifyTool(item({ id: "2", kind: "tool_call", title: "Edit `a.ts`" }))).toBe("edit");
    expect(
      classifyTool(item({ id: "3", kind: "tool_call", title: "Execute `npm test`" })),
    ).toBe("execute");
  });

  it("classifies grep by kind/variant and pattern titles", () => {
    expect(
      classifyTool(
        item({
          id: "g",
          kind: "tool_call",
          toolName: "search",
          title: "tool_call|ToolCall|collapsed",
          input: { variant: "Grep", pattern: "foo", path: "/x" },
        }),
      ),
    ).toBe("search");
  });
});

describe("toolShortLabel", () => {
  it("labels grep and shell cleanly", async () => {
    const { toolShortLabel } = await import("../stream-timeline.js");
    expect(
      toolShortLabel(
        item({
          id: "1",
          kind: "tool_result",
          toolName: "search",
          title: "grep",
          input: { variant: "Grep", pattern: "foo|bar", path: "/proj/src" },
        }),
      ),
    ).toMatch(/Grep/);
    expect(
      toolShortLabel(
        item({
          id: "2",
          kind: "tool_result",
          title: "Execute `npm test --watch`",
          input: { variant: "Bash", command: "npm test --watch" },
        }),
      ),
    ).toMatch(/npm/);
  });
});

describe("mergeToolsById", () => {
  it("merges call + result", () => {
    const out = mergeToolsById([
      item({
        id: "a",
        kind: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        status: "pending",
      }),
      item({
        id: "b",
        kind: "tool_result",
        toolCallId: "t1",
        status: "completed",
        output: "ok",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("completed");
    expect(out[0].output).toBe("ok");
  });
});

describe("buildTimeline", () => {
  it("groups 4 consecutive reads into one tool_group", () => {
    const items: StreamItem[] = [1, 2, 3, 4].map((n) =>
      item({
        id: `r${n}`,
        kind: "tool_result",
        toolCallId: `t${n}`,
        title: `Read \`file${n}.ts\``,
        status: "completed",
      }),
    );
    const tl = buildTimeline(items);
    expect(tl).toHaveLength(1);
    expect(tl[0].type).toBe("tool_group");
    if (tl[0].type === "tool_group") {
      expect(tl[0].label).toBe(toolClassLabel("read", 4));
      expect(tl[0].items).toHaveLength(4);
    }
  });

  it("keeps user/agent messages separate", () => {
    const tl = buildTimeline([
      item({ id: "u", kind: "user", text: "hi" }),
      item({ id: "a", kind: "agent_text", text: "hello" }),
    ]);
    expect(tl.map((e) => e.type)).toEqual(["item", "item"]);
  });
});
