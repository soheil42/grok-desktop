import { describe, expect, it } from "vitest";
import { detectTextDirection } from "../rtl.js";

describe("detectTextDirection", () => {
  it("detects Persian as RTL", () => {
    expect(detectTextDirection("سلام دنیا")).toBe("rtl");
    expect(detectTextDirection("این یک پیام فارسی است")).toBe("rtl");
  });

  it("detects English as LTR", () => {
    expect(detectTextDirection("Hello world")).toBe("ltr");
  });

  it("prefers dominant script in mixed text", () => {
    expect(detectTextDirection("سلام دوست من این یک پیام بلند فارسی است")).toBe("rtl");
    expect(detectTextDirection("Please fix the bug in auth.ts quickly")).toBe("ltr");
  });

  it("ignores code fences when scoring prose", () => {
    const t = "توضیح کوتاه\n```ts\nconst x = 1;\n```";
    expect(detectTextDirection(t)).toBe("rtl");
  });
});
