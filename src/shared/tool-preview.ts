/**
 * Turn raw tool input/output into human-readable previews (not JSON dumps).
 */
import type { DiffHunk, StreamItem } from "./types.js";
import { classifyTool, toolInputMeta } from "./stream-timeline.js";
import { extractQuestions, looksLikeAskUserQuestion } from "./user-questions.js";

export type ToolPreview =
  | { kind: "diff"; path: string; oldText: string; newText: string }
  | { kind: "code"; path?: string; language?: string; content: string; label?: string }
  | { kind: "shell"; command: string; output?: string }
  | { kind: "search"; pattern: string; path?: string; output?: string }
  | { kind: "questions"; lines: string[] }
  | { kind: "text"; content: string }
  | { kind: "empty" };

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length) return v;
  }
  return undefined;
}

/** Extract old/new strings from SearchReplace-shaped payloads. */
function extractEdit(item: StreamItem): {
  path?: string;
  oldText?: string;
  newText?: string;
} {
  const inp = asRec(item.input);
  const out = asRec(item.output);
  const applied = asRec(out?.EditsApplied) || asRec(out?.edits_applied);

  const path = pickStr(
    inp?.file_path,
    inp?.path,
    inp?.target_file,
    out?.absolute_path,
    out?.file_path,
    applied?.absolute_path,
  );

  const oldText = pickStr(
    inp?.old_string,
    inp?.oldText,
    applied?.old_string,
    applied?.oldText,
  );
  const newText = pickStr(
    inp?.new_string,
    inp?.newText,
    applied?.new_string,
    applied?.newText,
  );

  return { path, oldText, newText };
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "\n…";
}

/**
 * Build a display preview for a tool call/result.
 */
export function buildToolPreview(item: StreamItem): ToolPreview {
  const cls = classifyTool(item);
  const meta = toolInputMeta(item);

  // ask_user_question — list the prompts instead of "No preview"
  if (
    looksLikeAskUserQuestion(item.title, {
      input: item.input,
      raw: item.raw,
    })
  ) {
    const qs = extractQuestions({
      input: item.input,
      rawInput: item.input,
      raw: item.raw,
    });
    if (qs.length) {
      return {
        kind: "questions",
        lines: qs.map((q, i) => {
          const opts = q.options.map((o) => o.label).join(" · ");
          return opts
            ? `${i + 1}. ${q.question}\n   → ${opts}`
            : `${i + 1}. ${q.question}`;
        }),
      };
    }
  }

  if (item.diffs?.length) {
    const d = item.diffs[0];
    if (d.unified) {
      return {
        kind: "code",
        path: d.path,
        content: d.unified,
        label: "diff",
      };
    }
    if (d.oldText != null || d.newText != null) {
      return {
        kind: "diff",
        path: d.path,
        oldText: d.oldText || "",
        newText: d.newText || "",
      };
    }
  }

  if (cls === "edit") {
    const { path, oldText, newText } = extractEdit(item);
    if (oldText != null || newText != null) {
      return {
        kind: "diff",
        path: path || meta.path || "file",
        oldText: oldText || "",
        newText: newText || "",
      };
    }
  }

  if (cls === "read") {
    const content =
      typeof item.output === "string"
        ? item.output
        : typeof item.text === "string"
          ? item.text
          : "";
    // Strip line-number prefixes from grok read output (e.g. "  12→code")
    const cleaned = content
      .split("\n")
      .map((line) => line.replace(/^\s*\d+→/, ""))
      .join("\n");
    if (cleaned.trim()) {
      return {
        kind: "code",
        path: meta.path || item.title?.match(/`([^`]+)`/)?.[1],
        content: trunc(cleaned, 4000),
        label: "file",
      };
    }
  }

  if (cls === "execute") {
    const cmd =
      meta.command ||
      item.title?.match(/^Execute\s+`([\s\S]+)`/i)?.[1] ||
      "";
    const output =
      typeof item.output === "string"
        ? item.output
        : typeof item.text === "string"
          ? item.text
          : undefined;
    if (cmd || output) {
      return {
        kind: "shell",
        command: cmd || "(command)",
        output: output ? trunc(output, 3000) : undefined,
      };
    }
  }

  if (cls === "search" || cls === "web") {
    const pattern = meta.pattern || meta.query || "";
    const output =
      typeof item.output === "string"
        ? item.output
        : typeof item.text === "string"
          ? item.text
          : undefined;
    return {
      kind: "search",
      pattern: pattern || "…",
      path: meta.path,
      output: output ? trunc(output, 2500) : undefined,
    };
  }

  // Fallback: avoid dumping huge JSON objects
  if (typeof item.output === "string" && item.output.trim()) {
    return { kind: "text", content: trunc(item.output, 2500) };
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return { kind: "text", content: trunc(item.text, 2500) };
  }

  // Last resort for edits: try nested tool_output_for_prompt
  const out = asRec(item.output);
  const promptOut = pickStr(out?.tool_output_for_prompt_concise, out?.tool_output_for_prompt);
  if (promptOut) return { kind: "text", content: trunc(promptOut, 2000) };

  return { kind: "empty" };
}

export function formatUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines = [
    `--- a/${basename(path)}`,
    `+++ b/${basename(path)}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  // Simple full-file replace view (not a real LCS diff — readable enough)
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);
  return lines.join("\n");
}

export type { DiffHunk };
