/**
 * Delete a Grok session directory and any subagent sessions it spawned.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionsRoot } from "./session-index.js";

function rmrf(target: string): void {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Resolve session directory under grok home from id or absolute path.
 */
export function resolveSessionDir(
  grokHome: string,
  opts: { sessionId?: string; sessionPath?: string },
): string | null {
  if (opts.sessionPath) {
    const resolved = path.resolve(opts.sessionPath);
    const root = path.resolve(sessionsRoot(grokHome));
    if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  if (opts.sessionId) {
    const root = sessionsRoot(grokHome);
    if (!fs.existsSync(root)) return null;
    for (const group of fs.readdirSync(root)) {
      if (group.startsWith(".")) continue;
      const candidate = path.join(root, group, opts.sessionId);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Delete session + child sessions referenced under subagents/ and by parent_session_id scan.
 */
export function deleteSessionTree(
  grokHome: string,
  opts: { sessionId?: string; sessionPath?: string },
): { ok: boolean; deleted: string[]; error?: string } {
  const deleted: string[] = [];
  try {
    const sessionDir = resolveSessionDir(grokHome, opts);
    if (!sessionDir) {
      return { ok: false, deleted, error: "Session not found on disk" };
    }

    const sessionId = opts.sessionId || path.basename(sessionDir);
    const root = sessionsRoot(grokHome);

    // 1) Subagents folder inside the session (metadata / nested)
    const subMeta = path.join(sessionDir, "subagents");
    if (fs.existsSync(subMeta)) {
      try {
        for (const child of fs.readdirSync(subMeta)) {
          if (child.startsWith(".")) continue;
          // Child may be a session id that lives as a sibling under the same group
          const groupDir = path.dirname(sessionDir);
          const childDir = path.join(groupDir, child);
          if (fs.existsSync(childDir) && childDir !== sessionDir) {
            rmrf(childDir);
            deleted.push(childDir);
          }
        }
      } catch {
        // ignore
      }
    }

    // 2) Scan all sessions for parent_session_id === this session
    if (fs.existsSync(root)) {
      for (const group of fs.readdirSync(root)) {
        if (group.startsWith(".")) continue;
        const groupDir = path.join(root, group);
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(groupDir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name.startsWith(".") || name === sessionId) continue;
          const childDir = path.join(groupDir, name);
          const summaryPath = path.join(childDir, "summary.json");
          if (!fs.existsSync(summaryPath)) continue;
          try {
            const data = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
              parent_session_id?: string;
            };
            if (data.parent_session_id === sessionId) {
              rmrf(childDir);
              deleted.push(childDir);
            }
          } catch {
            // skip
          }
        }
      }
    }

    // 3) Delete the main session directory last
    rmrf(sessionDir);
    deleted.push(sessionDir);

    return { ok: true, deleted };
  } catch (e) {
    return {
      ok: false,
      deleted,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
