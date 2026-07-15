/**
 * Parse user/agent message text for display:
 * - strip or extract <system-reminder> blocks (harness noise)
 * - extract [Image #N] chips and image file paths
 */

export type ParsedImageRef = {
  /** 1-based index from [Image #N], if present */
  index?: number;
  /** Display label */
  label: string;
  /** Absolute path when known */
  path?: string;
  /** data: URL when available (from chat_history) */
  dataUrl?: string;
};

export type ParsedMessageContent = {
  /** Clean text for markdown bubble */
  text: string;
  /** True when the entire message was only system-reminder (should hide or compact) */
  isSystemOnly: boolean;
  /** Optional short system notices for compact chips (empty when hidden) */
  systemNotices: string[];
  /** Image attachments for gallery above the bubble */
  images: ParsedImageRef[];
};

const SYSTEM_RE =
  /<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/gi;
const IMAGE_CHIP_RE = /\[Image\s*#(\d+)\]/gi;
const IMAGE_PATH_RE =
  /(?:^|\s)(\/(?:[^\s"'<>]+\.(?:png|jpe?g|gif|webp|heic)))/gi;

/** Summarize a system-reminder into a one-line notice, or null to hide. */
export function summarizeSystemReminder(body: string): string | null {
  const t = body.trim();
  if (!t) return null;

  // Background task completed
  const bg = t.match(
    /Background task\s+"([^"]+)"\s+completed(?:\s*\(([^)]+)\))?/i,
  );
  if (bg) {
    const status = bg[2] ? ` · ${bg[2]}` : "";
    return `Background task finished${status}`;
  }

  // Goal set / harness — hide completely (too noisy)
  if (/A goal has been set/i.test(t)) return null;
  if (/You are working directly on this goal/i.test(t)) return null;
  if (/The following skills are available/i.test(t)) return null;
  if (/Plan:.*goal\/plan\.md/i.test(t)) return null;
  if (/Verification REJECTED/i.test(t)) return null;
  if (/Goal NOT complete/i.test(t)) return null;
  if (/task_completion_discipline/i.test(t)) return null;
  if (/SCRATCH:/i.test(t) && /TRACKING:/i.test(t)) return null;

  // Generic short reminder
  const first = t.split("\n").map((l) => l.trim()).find(Boolean) || "";
  if (first.length > 100) return first.slice(0, 97) + "…";
  return first || null;
}

/**
 * Parse raw message text into clean display parts.
 * @param hideSystem when true (default), system-reminders are stripped and only optional short notices kept.
 */
export function parseMessageContent(
  raw: string,
  opts?: { hideSystem?: boolean; keepSystemChips?: boolean },
): ParsedMessageContent {
  const hideSystem = opts?.hideSystem !== false;
  const keepSystemChips = opts?.keepSystemChips === true;
  let text = raw || "";
  const systemNotices: string[] = [];
  const images: ParsedImageRef[] = [];

  // Extract system-reminders
  text = text.replace(SYSTEM_RE, (_m, body: string) => {
    if (!hideSystem) return _m;
    if (keepSystemChips) {
      const s = summarizeSystemReminder(body);
      if (s) systemNotices.push(s);
    }
    return "\n";
  });

  // Image chips [Image #N]
  text = text.replace(IMAGE_CHIP_RE, (_m, n: string) => {
    const index = parseInt(n, 10);
    images.push({
      index,
      label: `Image ${index}`,
    });
    return " ";
  });

  // Absolute image paths in text
  text = text.replace(IMAGE_PATH_RE, (_m, p: string) => {
    if (!images.some((i) => i.path === p)) {
      images.push({
        label: p.split(/[/\\]/).pop() || "Image",
        path: p,
      });
    }
    return " ";
  });

  // Clean whitespace
  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const isSystemOnly =
    !text &&
    images.length === 0 &&
    (systemNotices.length > 0 ||
      /<system-reminder>/i.test(raw) ||
      raw.trim().startsWith("<system-reminder>"));

  return { text, isSystemOnly, systemNotices, images };
}

/**
 * Apply parseMessageContent to a user stream item's text.
 * Returns null if the item should be hidden entirely.
 */
export function sanitizeUserMessageText(
  text: string | undefined,
): { text: string; images: ParsedImageRef[]; notices: string[] } | null {
  if (!text) return null;
  const parsed = parseMessageContent(text, {
    hideSystem: true,
    keepSystemChips: true,
  });
  // Pure system noise with no useful notice → hide
  if (parsed.isSystemOnly && parsed.systemNotices.length === 0) {
    return null;
  }
  // Pure system with only a short notice → still hide notice by default (cleaner chat)
  // User asked to fix ugly system-reminder — hide pure ones completely
  if (parsed.isSystemOnly) {
    return null;
  }
  return {
    text: parsed.text,
    images: parsed.images,
    notices: parsed.systemNotices,
  };
}
