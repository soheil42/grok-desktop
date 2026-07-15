/**
 * Normalize + segment agent markdown for reliable rendering.
 * GFM pipe-tables are extracted manually — remark-gfm + RTL often leaves them
 * as plain paragraphs, then bidi reorders the pipes into gibberish.
 */

/** Join two consecutive agent_text chunks without gluing fence/table to the next turn. */
export function joinAgentTextChunks(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;

  // Stream continuation inside an open fence — always concatenate raw
  if (countFenceMarkers(prev) % 2 === 1) {
    return prev + next;
  }

  // Closed fence immediately followed by prose (missing blank line between turns)
  if (/```\s*$/.test(prev.trimEnd()) && !next.startsWith("\n") && !next.startsWith("```")) {
    return prev.replace(/\s*$/, "") + "\n\n" + next;
  }

  // Table row glued to previous paragraph without newline
  if (!prev.endsWith("\n") && /^\|/.test(next)) {
    return prev + "\n" + next;
  }

  // Heading glued without newline
  if (!prev.endsWith("\n") && /^#{1,6}\s/.test(next)) {
    return prev + "\n\n" + next;
  }

  return prev + next;
}

function countFenceMarkers(text: string): number {
  const raw = text.match(/```/g);
  return raw ? raw.length : 0;
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
  let text = src;

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

  // Close dangling fence so following prose still renders while streaming
  const ticks = text.match(/```/g);
  if (ticks && ticks.length % 2 === 1) {
    text = text + "\n```";
  }

  // Close dangling bold that would eat the rest of the message
  const boldCount = (text.match(/\*\*/g) || []).length;
  if (boldCount % 2 === 1) text = text + "**";

  return text;
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
