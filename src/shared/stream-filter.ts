import type { StreamItem, StreamItemKind } from "./types.js";
import { sanitizeUserMessageText } from "./message-content.js";

/** Kinds shown in the default chat view (Codex/Claude style — no noise). */
const DEFAULT_VISIBLE: ReadonlySet<StreamItemKind> = new Set([
  "user",
  "agent_text",
  "thought",
  "tool_call",
  "tool_result",
  "plan",
  "permission",
  "error",
]);

/** System noise from Grok ACP that should never render as cards. */
const NOISE_TITLES = new Set([
  "available_commands_update",
  "hook_execution",
  "turn_completed",
  "session_summary_generated",
  "queue/changed",
  "mcp_initialized",
  "models/update",
  "settings/update",
  "announcements/update",
]);

/**
 * Keep only human-meaningful stream items. Drops empty cards and ACP noise
 * that previously rendered as a stack of empty bordered lines.
 * Also strips <system-reminder> noise from user messages.
 */
export function filterVisibleStreamItems(
  items: StreamItem[],
  opts?: { audit?: boolean },
): StreamItem[] {
  const out: StreamItem[] = [];
  for (const item of items) {
    if (opts?.audit) {
      if (hasRenderableContent(item)) out.push(item);
      continue;
    }
    if (!DEFAULT_VISIBLE.has(item.kind)) continue;
    if (item.kind === "system") continue;
    if (item.title && NOISE_TITLES.has(item.title)) continue;
    if (item.kind === "thought" && !item.text?.trim()) continue;
    if (item.kind === "agent_text" && !item.text?.trim()) continue;

    if (item.kind === "user") {
      const cleaned = sanitizeUserMessageText(item.text);
      if (!cleaned) continue; // pure system-reminder → hide
      if (!cleaned.text.trim() && !(cleaned.images.length > 0) && !item.images?.length) {
        continue;
      }
      out.push({
        ...item,
        text: cleaned.text,
        images: [
          ...(item.images || []),
          ...cleaned.images.map((im) => ({
            label: im.label,
            index: im.index,
            path: im.path,
            dataUrl: im.dataUrl,
          })),
        ],
      });
      continue;
    }

    if (
      (item.kind === "tool_call" || item.kind === "tool_result") &&
      !item.title &&
      !item.toolName &&
      item.input == null &&
      item.output == null &&
      !item.diffs?.length &&
      !item.text?.trim()
    ) {
      continue;
    }
    if (hasRenderableContent(item) || item.kind === "tool_call" || item.kind === "tool_result") {
      out.push(item);
    }
  }
  return out;
}

function hasRenderableContent(item: StreamItem): boolean {
  if (item.text?.trim()) return true;
  if (item.title?.trim()) return true;
  if (item.toolName?.trim()) return true;
  if (item.input != null) return true;
  if (item.output != null) return true;
  if (item.diffs?.length) return true;
  if (item.kind === "error") return true;
  if (item.kind === "permission") return true;
  return false;
}

/** Coalesce consecutive agent_text / thought after filtering. */
export function filterAndCoalesce(
  items: StreamItem[],
  coalesce: (items: StreamItem[]) => StreamItem[],
  opts?: { audit?: boolean },
): StreamItem[] {
  return coalesce(filterVisibleStreamItems(items, opts));
}
