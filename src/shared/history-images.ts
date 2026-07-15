/**
 * Attach session images to user messages for history display.
 * Sources:
 * 1. chat_history.jsonl content blocks type:"image" with data URLs
 * 2. session assets/ + images/ folders mapped to [Image #N] chips
 */
import fs from "node:fs";
import path from "node:path";
import type { MessageImage, StreamItem } from "./types.js";

function listSessionImageFiles(sessionPath: string): string[] {
  const dirs = ["assets", "images"];
  const files: { p: string; mtime: number }[] = [];
  for (const d of dirs) {
    const dir = path.join(sessionPath, d);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(png|jpe?g|gif|webp|heic)$/i.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) files.push({ p, mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  return files.map((f) => f.p);
}

/**
 * Collect per-user-turn image data URLs from chat_history.jsonl (tail).
 */
export function loadChatHistoryImages(
  sessionPath: string,
  maxUserTurns = 80,
): Array<MessageImage[]> {
  const file = path.join(sessionPath, "chat_history.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const turns: Array<MessageImage[]> = [];
  // Walk from end for efficiency, then reverse
  const collected: Array<MessageImage[]> = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < maxUserTurns; i--) {
    try {
      const o = JSON.parse(lines[i]) as {
        type?: string;
        role?: string;
        content?: unknown;
      };
      const isUser = o.type === "user" || o.role === "user";
      if (!isUser) continue;
      const content = o.content;
      const imgs: MessageImage[] = [];
      if (Array.isArray(content)) {
        let idx = 0;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "image" && typeof b.url === "string") {
            idx += 1;
            imgs.push({
              label: `Image ${idx}`,
              index: idx,
              dataUrl: b.url.startsWith("data:") ? b.url : undefined,
              path: !String(b.url).startsWith("data:") ? String(b.url) : undefined,
            });
          } else if (b.type === "image" && b.source) {
            idx += 1;
            const src = b.source as Record<string, unknown>;
            const data =
              typeof src.data === "string"
                ? `data:${src.media_type || "image/png"};base64,${src.data}`
                : undefined;
            imgs.push({ label: `Image ${idx}`, index: idx, dataUrl: data });
          }
        }
      }
      collected.push(imgs);
    } catch {
      // skip bad lines
    }
  }
  collected.reverse();
  return collected;
}

/**
 * Enrich prepared history items with image attachments.
 * Matches user messages (in order) to chat_history image turns, and
 * fills [Image #N] refs from session assets by index.
 */
export function attachImagesToHistory(
  items: StreamItem[],
  sessionPath: string,
): StreamItem[] {
  const assetFiles = listSessionImageFiles(sessionPath);
  const historyTurns = loadChatHistoryImages(sessionPath);
  let userOrdinal = 0;

  // Count how many user messages we'll have after prep — walk and assign
  const userIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "user") userIndices.push(i);
  }

  // historyTurns is last N user turns with images; align from the end
  const offset = Math.max(0, userIndices.length - historyTurns.length);

  return items.map((item, idx) => {
    if (item.kind !== "user") return item;

    const localUserIdx = userIndices.indexOf(idx);
    const turnImgs =
      localUserIdx >= offset
        ? historyTurns[localUserIdx - offset] || []
        : [];

    const existing = item.images || [];
    const merged: MessageImage[] = [...existing];

    // Prefer real data URLs from chat_history
    for (const im of turnImgs) {
      if (!merged.some((m) => m.dataUrl && im.dataUrl && m.dataUrl === im.dataUrl)) {
        merged.push(im);
      }
    }

    // Resolve [Image #N] without path via assets list (session-wide, best-effort)
    for (const im of merged) {
      if (!im.dataUrl && !im.path && im.index && assetFiles[im.index - 1]) {
        im.path = assetFiles[im.index - 1];
      }
    }

    // If message only has image chips with indices and no data yet, map all indices
    if (merged.length === 0 && item.text && /\[Image\s*#\d+\]/i.test(item.text)) {
      const re = /\[Image\s*#(\d+)\]/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(item.text))) {
        const index = parseInt(m[1], 10);
        const p = assetFiles[index - 1];
        merged.push({
          label: `Image ${index}`,
          index,
          path: p,
        });
      }
    }

    userOrdinal += 1;
    if (merged.length === 0) return item;
    return { ...item, images: merged };
  });
}

/** Read a file under ~/.grok as a data URL (for renderer <img>). */
export function fileToDataUrl(filePath: string, grokHome: string): string | null {
  try {
    const resolved = path.resolve(filePath);
    const home = path.resolve(grokHome);
    if (!resolved.startsWith(home + path.sep) && resolved !== home) {
      return null;
    }
    if (!fs.existsSync(resolved)) return null;
    const buf = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : "image/jpeg";
    // Cap size ~2.5MB for IPC
    if (buf.length > 2_500_000) {
      return `file://${resolved}`;
    }
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
