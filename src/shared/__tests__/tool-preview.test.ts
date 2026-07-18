import { describe, expect, it } from "vitest";
import { buildToolPreview } from "../tool-preview.js";
import type { StreamItem } from "../types.js";

function item(p: Partial<StreamItem> & Pick<StreamItem, "id" | "kind">): StreamItem {
  return { timestamp: 1, ...p };
}

describe("buildToolPreview", () => {
  it("renders edit as diff not JSON", () => {
    const p = buildToolPreview(
      item({
        id: "1",
        kind: "tool_result",
        title: "Edit `index.ts`",
        toolName: "edit",
        input: {
          file_path: "/x/index.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
        output: {
          type: "SearchReplace",
          EditsApplied: {
            old_string: "const a = 1;",
            new_string: "const a = 2;",
            absolute_path: "/x/index.ts",
          },
        },
      }),
    );
    expect(p.kind).toBe("diff");
    if (p.kind === "diff") {
      expect(p.oldText).toContain("const a = 1");
      expect(p.newText).toContain("const a = 2");
      expect(p.path).toContain("index.ts");
    }
  });

  it("renders read as code", () => {
    const p = buildToolPreview(
      item({
        id: "2",
        kind: "tool_result",
        title: "Read `a.ts`",
        toolName: "read",
        input: { target_file: "/x/a.ts", variant: "ReadFile" },
        output: "  1→export const x = 1;\n  2→export const y = 2;",
      }),
    );
    expect(p.kind).toBe("code");
    if (p.kind === "code") {
      expect(p.content).toContain("export const x");
      expect(p.content).not.toMatch(/1→/);
    }
  });

  it("renders nested command results instead of an empty preview", () => {
    const p = buildToolPreview(
      item({
        id: "3",
        kind: "tool_result",
        title: "Execute `npm test`",
        toolName: "execute",
        input: { command: "npm test" },
        output: {
          type: "Bash",
          output: [98, 121, 116, 101, 115],
          output_for_prompt: "exit: 0\n12 tests passed",
        },
      }),
    );
    expect(p.kind).toBe("shell");
    if (p.kind === "shell") expect(p.output).toContain("12 tests passed");
  });

  it("includes the applied result beneath an edit diff", () => {
    const p = buildToolPreview(
      item({
        id: "4",
        kind: "tool_result",
        toolName: "edit",
        input: { file_path: "a.ts", old_string: "old", new_string: "new" },
        output: { output_for_prompt: "Applied edit successfully" },
      }),
    );
    expect(p.kind).toBe("diff");
    if (p.kind === "diff") expect(p.result).toContain("Applied edit");
  });
});
