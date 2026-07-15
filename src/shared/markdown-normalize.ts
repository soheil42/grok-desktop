/**
 * Normalize agent markdown for reliable rendering (esp. RTL + GFM tables/fences).
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

/** Count ``` markers (odd ⇒ currently inside a fenced block). */
function countFenceMarkers(text: string): number {
  const raw = text.match(/```/g);
  return raw ? raw.length : 0;
}

/**
 * Prep markdown string right before ReactMarkdown:
 * - close an unclosed fence so the rest of the message isn't swallowed as code
 * - ensure GFM tables have a blank line before them
 */
export function normalizeMarkdownForRender(src: string): string {
  if (!src) return src;
  let text = src;

  // Ensure a blank line before tables (GFM requirement)
  text = text.replace(/([^\n])\n(\|)/g, "$1\n\n$2");

  // Close dangling fence so following prose still renders while streaming
  const ticks = text.match(/```/g);
  if (ticks && ticks.length % 2 === 1) {
    text = text + "\n```";
  }

  return text;
}
