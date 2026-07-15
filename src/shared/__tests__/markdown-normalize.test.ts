import { describe, expect, it } from "vitest";
import {
  joinAgentTextChunks,
  normalizeMarkdownForRender,
} from "../markdown-normalize.js";

describe("joinAgentTextChunks", () => {
  it("concatenates normal stream tokens", () => {
    expect(joinAgentTextChunks("hel", "lo")).toBe("hello");
  });

  it("does not break open fences mid-stream", () => {
    expect(joinAgentTextChunks("```bash\n", "echo hi\n")).toBe("```bash\necho hi\n");
  });

  it("inserts blank line after closed fence before next turn prose", () => {
    const a = "run this:\n\n```bash\necho hi\n```";
    const b = "یادآوری مهم";
    expect(joinAgentTextChunks(a, b)).toBe(
      "run this:\n\n```bash\necho hi\n```\n\nیادآوری مهم",
    );
  });
});

describe("normalizeMarkdownForRender", () => {
  it("closes dangling fences so prose after stream is not swallowed", () => {
    const src = "code:\n```bash\necho hi";
    const out = normalizeMarkdownForRender(src);
    expect(out.endsWith("```")).toBe(true);
  });

  it("keeps a blank line before tables", () => {
    const src = "Status:\n| a | b |\n| - | - |\n| 1 | 2 |";
    const out = normalizeMarkdownForRender(src);
    expect(out).toContain("Status:\n\n| a | b |");
  });
});
