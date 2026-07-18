/**
 * Normalize + segment agent markdown for reliable rendering.
 * GFM pipe-tables are extracted manually — remark-gfm + RTL often leaves them
 * as plain paragraphs, then bidi reorders the pipes into gibberish.
 */

/**
 * Join ACP agent-message deltas.
 *
 * Chunk boundaries are transport details: a `|`, `#`, or backtick may arrive
 * in any chunk. Inferring Markdown structure here corrupts the source and made
 * live text differ from the same message loaded from disk. Message/turn
 * separation belongs in the stream timeline, not in the text concatenator.
 */
export function joinAgentTextChunks(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;

  // If Grok preserved whitespace, it is authoritative.
  if (/\s$/.test(prev) || /^\s/.test(next)) return prev + next;

  // Never infer prose structure while a fenced code block is open.
  if (countFenceMarkers(prev) % 2 === 1) return prev + next;

  const prevLine = prev.slice(prev.lastIndexOf("\n") + 1).trim();
  const nextLine = next.split("\n", 1)[0].trim();

  // The transport may split a table row at one of its internal pipes. If the
  // current row has not closed yet, the next pipe is continuation, not a row.
  if (prevLine.startsWith("|") && !prevLine.endsWith("|")) {
    return prev + next;
  }

  const tableRow = /^\|.*\|$/.test(nextLine) && (nextLine.match(/\|/g) || []).length >= 2;
  const listItem = /^(?:[-+*]|\d+[.)])\s+\S/.test(nextLine);
  const heading = /^#{1,6}\s+\S/.test(nextLine);
  const blockquote = /^>\s+\S/.test(nextLine);
  const fence = /^```/.test(nextLine);
  const rule = /^(?:-{3,}|\*{3,}|_{3,})$/.test(nextLine);

  // Grok's live ACP stream sometimes trims separators between semantic blocks,
  // while updates.jsonl stores the final message with those newlines restored.
  // Repair only complete Markdown block starts, never a lone transport token.
  if (tableRow || listItem || blockquote) {
    return `${prev}\n${next}`;
  }
  if (heading || fence || rule || /^```\s*$/.test(prevLine)) {
    return `${prev}\n\n${next}`;
  }

  // A heading chunk followed by prose, or a completed sentence followed by a
  // substantial new prose chunk, is another observed whitespace-loss shape.
  const prevIsHeading = /^#{1,6}\s+\S/.test(prevLine);
  const hasOpenInlineMarkup =
    (prevLine.match(/\*\*/g) || []).length % 2 === 1 ||
    (prevLine.match(/(?<!`)`(?!`)/g) || []).length % 2 === 1;
  const nextLooksLikeProse =
    nextLine.length >= 4 &&
    /^(?:[A-Z\d]|[\u0600-\u06ff])/.test(nextLine);
  if (
    !hasOpenInlineMarkup &&
    nextLooksLikeProse &&
    (prevIsHeading || /[.!?؟:؛]$/.test(prevLine))
  ) {
    return `${prev}\n\n${next}`;
  }

  return prev + next;
}

function countFenceMarkers(text: string): number {
  return (text.match(/```/g) || []).length;
}

export type MdTableAlign = "left" | "center" | "right" | "default";

export type MdSegment =
  | { type: "markdown"; text: string }
  | {
      type: "table";
      headers: string[];
      rows: string[][];
      aligns: MdTableAlign[];
    };

/**
 * Prep markdown string right before render.
 */
export function normalizeMarkdownForRender(src: string): string {
  if (!src) return src;
  let text = repairCollapsedMarkdownBlocks(src);

  // Normalize exotic pipes/dashes often seen in Persian exports
  text = text
    .replace(/[｜❘❙❚]/g, "|")
    .replace(/[‐‑‒–—―]/g, "-");

  // Strip bidi control marks that break table row detection
  text = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");

  // Ensure a blank line before a table block — but NEVER between table rows
  // (the old regex inserted \n\n between header and |---| and broke GFM + our parser)
  {
    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = out.length ? out[out.length - 1] : "";
      if (
        isPipeRow(line) &&
        prev.trim() !== "" &&
        !isPipeRow(prev) &&
        prev.trim() !== ""
      ) {
        out.push("");
      }
      out.push(line);
    }
    text = out.join("\n");
  }

  return text;
}

/** Repair block separators trimmed by Grok's live ACP transport. */
export function repairCollapsedMarkdownBlocks(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const original of lines) {
    const fenceCount = (original.match(/```/g) || []).length;
    if (inFence) {
      out.push(original);
      if (fenceCount % 2 === 1) inFence = false;
      continue;
    }
    if (/^\s*```/.test(original)) {
      out.push(original);
      if (fenceCount % 2 === 1) inFence = true;
      continue;
    }

    let line = original;
    // `paragraph### Heading` and `---## Heading` cannot be intentional prose.
    line = line.replace(/([^\n#])(?=#{1,6}\s+\S)/g, "$1\n\n");
    line = line.replace(/((?:^|\s)(?:---|\*\*\*|___))(?=#{1,6}\s+\S)/g, "$1\n\n");

    // A collapsed GFM table keeps both the closing and opening row pipes,
    // producing `| |` or `||`. Scope this to lines containing a separator row
    // so boolean operators and ordinary prose remain untouched.
    if (/\|\s*:?-{2,}:?\s*\|/.test(line)) {
      let previous = "";
      while (previous !== line) {
        previous = line;
        line = line.replace(/\|[ \t]*\|/g, "|\n|");
      }
    }
    out.push(line);
  }

  return out.join("\n");
}

function isPipeRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  // Must look like a table row: starts/ends with | or has multiple |
  const pipes = (t.match(/\|/g) || []).length;
  if (pipes < 2) return false;
  // Reject lines that are clearly prose with a single technical |
  if (!t.startsWith("|") && !t.endsWith("|") && pipes < 3) return false;
  return true;
}

function isSeparatorRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !/-{2,}/.test(t)) return false;
  // Only dashes, colons, pipes, spaces
  const core = t.replace(/\|/g, "").replace(/[\s:-]/g, "");
  return core.length === 0;
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function parseAligns(sepLine: string, colCount: number): MdTableAlign[] {
  const cells = splitCells(sepLine);
  const aligns: MdTableAlign[] = [];
  for (let i = 0; i < colCount; i++) {
    const c = (cells[i] || "").trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push("default");
  }
  return aligns;
}

/**
 * Split markdown into prose segments and explicit table segments.
 * Tables are rendered by React, not remark-gfm — reliable under RTL.
 */
export function segmentMarkdown(src: string): MdSegment[] {
  const text = normalizeMarkdownForRender(src);
  const lines = text.split("\n");
  const segments: MdSegment[] = [];
  let buf: string[] = [];

  const flush = () => {
    // Keep empty lines so markdown spacing is preserved
    if (buf.length === 0) return;
    const block = buf.join("\n");
    // Don't push purely empty trailing blocks unless meaningful
    if (block.trim().length === 0 && segments.length === 0) {
      buf = [];
      return;
    }
    segments.push({ type: "markdown", text: block });
    buf = [];
  };

  let i = 0;
  while (i < lines.length) {
    // Table: header row + separator + 0+ body rows
    if (
      i + 1 < lines.length &&
      isPipeRow(lines[i]) &&
      isSeparatorRow(lines[i + 1])
    ) {
      flush();
      const headers = splitCells(lines[i]);
      const aligns = parseAligns(lines[i + 1], headers.length);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isPipeRow(lines[i]) && !isSeparatorRow(lines[i])) {
        const cells = splitCells(lines[i]);
        // Pad / trim to header width
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
        i += 1;
      }
      segments.push({ type: "table", headers, rows, aligns });
      continue;
    }
    buf.push(lines[i]);
    i += 1;
  }
  flush();
  return segments.length ? segments : [{ type: "markdown", text }];
}
