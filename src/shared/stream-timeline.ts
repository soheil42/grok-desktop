/**
 * Build a chat timeline like Grok CLI scrollback:
 * - merge tool_call + tool_call_update by id
 * - use ACP kind / input.variant for classification (not just titles)
 * - collapse consecutive same-class tools ("Read 4 files", "3 searches")
 * - collapse consecutive thoughts
 */
import type { StreamItem, ToolCallStatus } from "./types.js";
import { filterVisibleStreamItems } from "./stream-filter.js";
import { coalesceStreamItems, preferToolStatus } from "./acp-parser.js";

export type ToolClass =
  | "read"
  | "edit"
  | "execute"
  | "search"
  | "web"
  | "todo"
  | "other";

export type TimelineEntry =
  | { type: "item"; item: StreamItem }
  | {
      type: "tool_group";
      id: string;
      toolClass: ToolClass;
      label: string;
      items: StreamItem[];
      status: string;
    }
  | {
      type: "thought_group";
      id: string;
      text: string;
      items: StreamItem[];
    };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Pull structured fields from tool input (ACP rawInput). */
export function toolInputMeta(item: StreamItem): {
  variant?: string;
  path?: string;
  command?: string;
  pattern?: string;
  query?: string;
} {
  const inp = asRecord(item.input) || asRecord(item.raw);
  if (!inp) return {};
  // Nested sometimes
  const inner = asRecord(inp.rawInput) || inp;
  const variant = inner.variant != null ? String(inner.variant) : undefined;
  const path =
    (inner.target_file as string) ||
    (inner.target_directory as string) ||
    (inner.path as string) ||
    (inner.file as string) ||
    (inner.glob as string) ||
    undefined;
  const command = inner.command != null ? String(inner.command) : undefined;
  const pattern =
    inner.pattern != null
      ? String(inner.pattern)
      : inner.query != null
        ? String(inner.query)
        : undefined;
  const query = inner.query != null ? String(inner.query) : undefined;
  return { variant, path, command, pattern, query };
}

export function classifyTool(item: StreamItem): ToolClass {
  const kind = (item.toolName || "").toLowerCase();
  const { variant } = toolInputMeta(item);
  const v = (variant || "").toLowerCase();
  const title = `${item.title || ""}`.trim();

  // Prefer ACP kind / variant (reliable)
  if (
    kind === "read" ||
    v === "readfile" ||
    v === "listdir" ||
    kind === "read_file" ||
    /list_dir|read_file/i.test(item.title || "")
  ) {
    return "read";
  }
  if (
    kind === "edit" ||
    v === "edit" ||
    v === "write" ||
    v === "searchreplace" ||
    /search_replace|^write$|^Creating\s|^Edited\s|^Edit\s|^Write\s/i.test(title)
  ) {
    return "edit";
  }
  if (
    kind === "execute" ||
    v === "bash" ||
    v === "shell" ||
    /run_terminal|execute|^Shell\b|^\[bg\]/i.test(title)
  ) {
    return "execute";
  }
  if (kind === "search" || v === "grep" || v === "search" || title === "grep") {
    return "search";
  }
  if (/web search|web_search/i.test(title) || v === "websearch") {
    return "web";
  }
  // Plan/todo updates are filtered as noise; if any remain, treat as todo
  if (/todo|plan/i.test(title) || v === "todowrite" || v === "plan") {
    return "todo";
  }

  // Title patterns from Grok updates
  if (/^List\s+`/i.test(title) || /^Read\s+`/i.test(title) || title === "list_dir" || title === "read_file") {
    return "read";
  }
  if (/^Edit\s+`/i.test(title) || /^Write\s+`/i.test(title) || title === "write") {
    return "edit";
  }
  if (/^Execute\s+`/i.test(title) || title === "run_terminal_command") {
    return "execute";
  }
  // Grep often uses the pattern as title (looks like raw regex)
  if (kind === "search" || title === "grep") return "search";
  // Heuristic: titles that look like search patterns (no spaces path, has | or regex-ish)
  if (!title.includes("/") && (title.includes("|") || title.includes("\\") || title.includes(".*"))) {
    return "search";
  }

  return "other";
}

export function toolClassLabel(cls: ToolClass, count: number): string {
  switch (cls) {
    case "read":
      return count === 1 ? "Read 1 file" : `Read ${count} files`;
    case "edit":
      return count === 1 ? "Edited 1 file" : `Edited ${count} files`;
    case "execute":
      return count === 1 ? "Ran 1 command" : `Ran ${count} commands`;
    case "search":
      return count === 1 ? "1 search" : `${count} searches`;
    case "web":
      return count === 1 ? "1 web search" : `${count} web searches`;
    case "todo":
      return count === 1 ? "Updated todos" : `Updated todos ×${count}`;
    default:
      return count === 1 ? "1 tool" : `${count} tools`;
  }
}

export function toolActivityLabel(items: StreamItem[]): string {
  const counts = new Map<ToolClass, number>();
  for (const item of items) {
    const cls = classifyTool(item);
    counts.set(cls, (counts.get(cls) || 0) + 1);
  }
  const order: ToolClass[] = ["read", "edit", "execute", "search", "web", "todo", "other"];
  return order
    .filter((cls) => counts.has(cls))
    .map((cls) => toolClassLabel(cls, counts.get(cls) || 0))
    .join(", ");
}

/** Human chip label — CLI-like, never dump raw JSON/patterns as the only label. */
export function toolShortLabel(item: StreamItem): string {
  const meta = toolInputMeta(item);
  const cls = classifyTool(item);
  const title = (item.title || "").trim();

  if (cls === "read") {
    const p =
      meta.path ||
      title.match(/`([^`]+)`/)?.[1] ||
      (title !== "read_file" && title !== "list_dir" ? title : "");
    if (p) {
      const isList = /list/i.test(title) || meta.variant === "ListDir";
      return `${isList ? "List" : "Read"} ${basename(p)}`;
    }
    return title === "list_dir" ? "List directory" : "Read file";
  }

  if (cls === "edit") {
    const p =
      meta.path ||
      title.match(/`([^`]+)`/)?.[1] ||
      title.match(/(?:Creating|Created|Edit(?:ed|ing)?|Write|Wrote)\s+(\S+)/i)?.[1];
    if (p) {
      const isCreate = /creat|write|wrote/i.test(title) && !/edit/i.test(title);
      return `${isCreate ? "Create" : "Edit"} ${basename(p.replace(/[`'"]/g, ""))}`;
    }
    return title === "write" ? "Write file" : "Edit file";
  }

  if (cls === "execute") {
    const cmd =
      meta.command ||
      title.match(/^Execute\s+`([\s\S]+)`/i)?.[1] ||
      (title !== "run_terminal_command" ? title : "");
    if (cmd) {
      // First meaningful token line
      const first = cmd.split("\n")[0].replace(/\s+/g, " ").trim();
      // Prefer command name: npm, node, ls, …
      const token = first.replace(/^sudo\s+/, "").split(/\s+/)[0] || first;
      const pretty = first.length > 52 ? first.slice(0, 49) + "…" : first;
      // If starts with comment, use generic
      if (first.startsWith("#")) return `Shell · ${trunc(first.replace(/^#\s*/, ""), 40)}`;
      return pretty || token || "Shell";
    }
    return "Shell";
  }

  if (cls === "search") {
    const pat = meta.pattern || (title !== "grep" ? title : "");
    const where = meta.path ? basename(meta.path) : "";
    if (pat) {
      const p = trunc(pat, 36);
      return where ? `Grep “${p}” in ${where}` : `Grep “${p}”`;
    }
    return "Grep";
  }

  if (cls === "web") {
    const q = meta.query || meta.pattern || title.replace(/^Web search:\s*/i, "");
    return q ? `Web · ${trunc(q, 40)}` : "Web search";
  }

  if (cls === "todo") return "Todos";

  // ask_user_question — e.g. "Ask 4 questions"
  if (/ask\s+\d+\s+questions?/i.test(title) || /ask_user_question/i.test(title)) {
    return title.length < 48 ? title : trunc(title, 48);
  }

  // Fallback: clean title, never huge
  if (title && title.length < 60 && !title.startsWith("{")) {
    return trunc(title, 52);
  }
  return item.toolName && item.toolName !== "other" ? item.toolName : "Tool";
}

/**
 * Merge tool_call / tool_result sharing toolCallId (keep richest version).
 * Prefer later human titles (Read `path`) over early (read_file).
 */
export function mergeToolsById(items: StreamItem[]): StreamItem[] {
  const byId = new Map<string, StreamItem>();
  const order: string[] = [];
  const out: StreamItem[] = [];

  const betterTitle = (a?: string, b?: string): string | undefined => {
    if (!a) return b;
    if (!b) return a;
    // Prefer paths / Execute / List over raw tool ids
    const score = (t: string) => {
      if (/^Read\s+`|^Edit\s+`|^Write\s+`|^List\s+`|^Execute\s+`/i.test(t)) return 3;
      if (t.includes("`") || t.includes("/")) return 2;
      if (/^(read_file|list_dir|write|grep|run_terminal)/i.test(t)) return 0;
      return 1;
    };
    return score(b) >= score(a) ? b : a;
  };

  const finalizeTool = (t: StreamItem): StreamItem => {
    const cur = t.status;
    // Once we have a result payload, stop blinking as "running"
    if (cur === "failed" || cur === "cancelled" || cur === "completed") {
      return { ...t, status: cur };
    }
    if (
      t.output != null ||
      (t.diffs && t.diffs.length > 0) ||
      t.kind === "tool_result"
    ) {
      return { ...t, status: "completed" };
    }
    return { ...t, status: cur || "pending" };
  };

  for (const item of items) {
    if (
      (item.kind === "tool_call" || item.kind === "tool_result") &&
      item.toolCallId
    ) {
      const id = item.toolCallId;
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, { ...item });
        order.push(id);
      } else {
        byId.set(id, {
          ...prev,
          ...item,
          id: prev.id,
          kind:
            item.kind === "tool_result" || prev.kind === "tool_result"
              ? "tool_result"
              : "tool_call",
          title: betterTitle(prev.title, item.title),
          toolName: item.toolName || prev.toolName,
          status: preferToolStatus(prev.status, item.status),
          input: item.input ?? prev.input,
          output: item.output ?? prev.output,
          text: item.text || prev.text,
          diffs: item.diffs?.length ? item.diffs : prev.diffs,
          timestamp: item.timestamp || prev.timestamp,
          raw: item.raw ?? prev.raw,
        });
      }
      continue;
    }
    if (order.length && item.kind !== "tool_call" && item.kind !== "tool_result") {
      // Non-tool content after tools ⇒ those tools finished their turn
      for (const id of order) {
        const t = byId.get(id);
        if (t) {
          const fin = finalizeTool(t);
          // Agent continued past this tool — if still running, treat as done
          if (fin.status === "pending" || fin.status === "in_progress") {
            out.push({ ...fin, status: "completed" });
          } else {
            out.push(fin);
          }
        }
        byId.delete(id);
      }
      order.length = 0;
    }
    out.push(item);
  }
  for (const id of order) {
    const t = byId.get(id);
    if (t) out.push(finalizeTool(t));
  }
  return out;
}

/**
 * Build display timeline from raw stream items.
 */
export function buildTimeline(items: StreamItem[]): TimelineEntry[] {
  const cleaned = mergeToolsById(
    coalesceStreamItems(filterVisibleStreamItems(items)),
  );
  const timeline: TimelineEntry[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const cur = cleaned[i];

    if (cur.kind === "thought") {
      const group: StreamItem[] = [];
      while (i < cleaned.length && cleaned[i].kind === "thought") {
        group.push(cleaned[i]);
        i++;
      }
      const text = group.map((g) => g.text || "").join("");
      if (text.trim()) {
        timeline.push({
          type: "thought_group",
          id: `thoughts-${group[0].id}`,
          text,
          items: group,
        });
      }
      continue;
    }

    // Keep only the latest plan block in a consecutive run (CLI shows one plan)
    if (cur.kind === "plan") {
      let last = cur;
      i++;
      while (i < cleaned.length && cleaned[i].kind === "plan") {
        last = cleaned[i];
        i++;
      }
      if ((last.text || "").trim() || (last.title || "").trim()) {
        timeline.push({ type: "item", item: last });
      }
      continue;
    }

    if (cur.kind === "tool_call" || cur.kind === "tool_result") {
      const group: StreamItem[] = [cur];
      let j = i + 1;
      while (j < cleaned.length) {
        const n = cleaned[j];
        if (n.kind !== "tool_call" && n.kind !== "tool_result") break;
        group.push(n);
        j++;
      }
      // One compact activity line, even when the agent alternates read/search/
      // execute calls. The expanded list preserves exact chronological order.
      if (group.length >= 2) {
        const groupStatus = group.some((g) => g.status === "failed")
          ? "failed"
          : group.some((g) => g.status === "in_progress")
            ? "in_progress"
            : group.some((g) => g.status === "pending")
              ? "pending"
              : "completed";
        timeline.push({
          type: "tool_group",
          id: `tg-${group[0].id}`,
          toolClass: classifyTool(cur),
          label: toolActivityLabel(group),
          items: group,
          status: groupStatus,
        });
        i = j;
        continue;
      }
      timeline.push({ type: "item", item: cur });
      i++;
      continue;
    }

    timeline.push({ type: "item", item: cur });
    i++;
  }
  return timeline;
}

export function tailTimeline(
  timeline: TimelineEntry[],
  maxEntries = 40,
): { visible: TimelineEntry[]; hiddenCount: number } {
  if (timeline.length <= maxEntries) {
    return { visible: timeline, hiddenCount: 0 };
  }
  return {
    visible: timeline.slice(-maxEntries),
    hiddenCount: timeline.length - maxEntries,
  };
}

/**
 * Prepare history for a single React paint: merge + filter, hard-cap size.
 * Call from main process or before setState.
 */
export function prepareHistoryItems(items: StreamItem[], maxItems = 200): StreamItem[] {
  const merged = mergeToolsById(
    coalesceStreamItems(filterVisibleStreamItems(items)),
  );
  if (merged.length <= maxItems) return merged;
  // Keep last N (recent conversation)
  return merged.slice(-maxItems);
}
