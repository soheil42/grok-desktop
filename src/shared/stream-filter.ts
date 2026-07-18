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
      if (
        !cleaned.text.trim() &&
        !(cleaned.images.length > 0) &&
        !item.images?.length &&
        !item.attachments?.length
      ) {
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

    if (item.kind === "tool_call" || item.kind === "tool_result") {
      if (isNoiseToolCall(item)) continue;
      if (
        !item.title &&
        !item.toolName &&
        item.input == null &&
        item.output == null &&
        !item.diffs?.length &&
        !item.text?.trim()
      ) {
        continue;
      }
      out.push(item);
      continue;
    }
    if (hasRenderableContent(item)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Tools that add noise vs Grok CLI scrollback — hide unless audit mode.
 * (CLI shows Creating/Edited with paths; not bare "Tool" / plan spam chips.)
 */
export function isNoiseToolCall(item: StreamItem): boolean {
  const title = (item.title || "").trim();
  const tool = (item.toolName || "").toLowerCase();
  const blob = `${title}\n${tool}\n${JSON.stringify(item.input ?? {}).slice(0, 200)}`.toLowerCase();

  // Generic placeholder chip with no path/command
  if (!title || /^tool$/i.test(title) || /^tool_call/i.test(title)) {
    const hasPath = /path|target_file|file|command|pattern/i.test(
      JSON.stringify(item.input ?? {}).slice(0, 400),
    );
    if (!hasPath) return true;
  }

  // Plan / todo stream spam (plan body is already shown as Plan blocks)
  if (
    /updating plan|update.?plan|todo_write|create.?plan|enter_plan|exit_plan|plan_mode/i.test(
      blob,
    )
  ) {
    return true;
  }

  // ACP internal collapsed titles
  if (/\|ToolCall\|collapsed/i.test(title)) return true;
  if (/^session_update|^available_commands/i.test(title)) return true;

  // Bare tool name ids without human title
  if (
    /^(read_file|list_dir|write|search_replace|run_terminal_command|grep|todo_write)$/i.test(
      title,
    ) &&
    item.status === "pending"
  ) {
    // keep pending shell/read if we have input; else hide early stubs
    if (item.input == null && !item.text) return true;
  }

  return false;
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
