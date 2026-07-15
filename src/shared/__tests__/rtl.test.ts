import { describe, expect, it } from "vitest";
import {
  resolveChromeDirection,
  codeRegionProps,
  proseRegionProps,
  shellDocumentAttrs,
  isRtlLocale,
} from "../rtl.js";

describe("rtl helpers", () => {
  it("resolves explicit ltr/rtl preferences", () => {
    expect(resolveChromeDirection("rtl", "en")).toBe("rtl");
    expect(resolveChromeDirection("ltr", "ar")).toBe("ltr");
  });

  it("auto-detects RTL locales", () => {
    expect(resolveChromeDirection("auto", "ar")).toBe("rtl");
    expect(resolveChromeDirection("auto", "ar-SA")).toBe("rtl");
    expect(resolveChromeDirection("auto", "fa-IR")).toBe("rtl");
    expect(resolveChromeDirection("auto", "he")).toBe("rtl");
    expect(resolveChromeDirection("auto", "en-US")).toBe("ltr");
  });

  it("isolates code regions as LTR", () => {
    const code = codeRegionProps();
    expect(code.dir).toBe("ltr");
    expect(code.style.unicodeBidi).toBe("isolate");
    expect(code.className).toContain("ltr");
  });

  it("uses smart dir for mixed prose", () => {
    expect(proseRegionProps("hello").dir).toBe("ltr");
    expect(proseRegionProps("سلام").dir).toBe("rtl");
    expect(proseRegionProps().dir).toBe("auto");
  });

  it("shellDocumentAttrs sets dir and lang hint", () => {
    expect(shellDocumentAttrs("rtl")).toEqual({ dir: "rtl", langHint: "fa" });
    expect(shellDocumentAttrs("ltr").dir).toBe("ltr");
  });

  it("isRtlLocale matches Arabic family", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("en")).toBe(false);
  });
});
