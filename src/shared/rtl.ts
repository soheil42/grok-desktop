import type { TextDirection } from "./types.js";

/** Locales that should default the chrome to RTL. */
const RTL_LOCALES = new Set([
  "ar",
  "he",
  "fa",
  "ur",
  "yi",
  "ps",
  "sd",
  "ug",
  "ckb",
  "dv",
]);

/** Strong RTL script ranges (Arabic, Hebrew, etc.). */
const RTL_CHAR =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Resolve UI chrome direction from an explicit preference or locale BCP-47 tag.
 */
export function resolveChromeDirection(
  preference: TextDirection | "auto",
  locale: string,
): TextDirection {
  if (preference === "ltr" || preference === "rtl") return preference;
  const primary = (locale || "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
  return RTL_LOCALES.has(primary) ? "rtl" : "ltr";
}

/**
 * Smart direction for a message or input string.
 * Uses character counts on prose (code fences stripped) so mixed Persian+English
 * picks the dominant script. Code-only stays LTR via auto/ltr.
 */
export function detectTextDirection(text: string): TextDirection | "auto" {
  if (!text || !text.trim()) return "auto";
  // Remove fenced code & inline code for prose detection
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");

  let rtl = 0;
  let ltr = 0;
  for (const ch of prose) {
    if (RTL_CHAR.test(ch)) rtl += 1;
    else if (/[A-Za-z]/.test(ch)) ltr += 1;
  }
  if (rtl === 0 && ltr === 0) return "auto";
  // Slight bias so short Persian replies (e.g. "سلام") win
  if (rtl >= ltr) return "rtl";
  return "ltr";
}

/**
 * Code, diffs, terminals, and file paths must stay LTR-isolated even in RTL chrome.
 */
export function codeRegionProps(): {
  dir: "ltr";
  className: string;
  style: { unicodeBidi: "isolate" };
} {
  return {
    dir: "ltr",
    className: "ltr-isolate code-font",
    style: { unicodeBidi: "isolate" },
  };
}

/**
 * Prose region with smart direction from content.
 */
export function proseRegionProps(text?: string): {
  dir: TextDirection | "auto";
  className: string;
  lang?: string;
} {
  const dir = text ? detectTextDirection(text) : "auto";
  return {
    dir,
    className: dir === "rtl" ? "prose-rtl" : dir === "ltr" ? "prose-ltr" : "prose-auto",
    lang: dir === "rtl" ? "fa" : undefined,
  };
}

/**
 * Root document attributes for the shell.
 */
export function shellDocumentAttrs(direction: TextDirection): {
  dir: TextDirection;
  langHint: string;
} {
  return {
    dir: direction,
    langHint: direction === "rtl" ? "fa" : "en",
  };
}

export function sidebarEdge(_direction: TextDirection): "start" | "end" {
  return "start";
}

export function isRtlLocale(locale: string): boolean {
  return resolveChromeDirection("auto", locale) === "rtl";
}
