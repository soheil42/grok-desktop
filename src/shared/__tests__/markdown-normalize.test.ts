import { describe, expect, it } from "vitest";
import {
  joinAgentTextChunks,
  normalizeMarkdownForRender,
  segmentMarkdown,
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

describe("segmentMarkdown", () => {
  it("extracts a Persian GFM table as a table segment", () => {
    const src = `بر اساس پیام‌ها:

| موضوع | درصد | معنی |
| --- | --- | --- |
| قیمت / خرید / پلن | ۴۳٪ | شفاف نیست |
| مشکل پرداخت | ۲۵٪ | فرصت upsell |

بعد از جدول.`;

    const segs = segmentMarkdown(src);
    const table = segs.find((s) => s.type === "table");
    expect(table).toBeTruthy();
    if (table && table.type === "table") {
      expect(table.headers).toEqual(["موضوع", "درصد", "معنی"]);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0][0]).toContain("قیمت");
      expect(table.rows[1][1]).toBe("۲۵٪");
    }
    // Prose before and after preserved
    expect(segs.some((s) => s.type === "markdown" && s.text.includes("بر اساس"))).toBe(
      true,
    );
    expect(segs.some((s) => s.type === "markdown" && s.text.includes("بعد از جدول"))).toBe(
      true,
    );
  });

  it("handles separator without spaces", () => {
    const src = `| a | b |
|---|---|
| 1 | 2 |`;
    const segs = segmentMarkdown(src);
    expect(segs[0].type).toBe("table");
    if (segs[0].type === "table") {
      expect(segs[0].rows[0]).toEqual(["1", "2"]);
    }
  });
});
