import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectInfo, SessionSummary } from "./types.js";

export function defaultGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GROK_HOME && env.GROK_HOME.trim()) return env.GROK_HOME.trim();
  return path.join(os.homedir(), ".grok");
}

export function sessionsRoot(grokHome: string): string {
  return path.join(grokHome, "sessions");
}

/**
 * Grok encodes the working directory as a URL-encoded path segment.
 * When too long it uses slug+hash; we decode when possible.
 */
export function decodeEncodedCwd(encoded: string, groupDir?: string): string {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // fall through
  }
  if (groupDir) {
    const cwdFile = path.join(groupDir, ".cwd");
    try {
      if (fs.existsSync(cwdFile)) {
        return fs.readFileSync(cwdFile, "utf8").trim();
      }
    } catch {
      // ignore
    }
  }
  return encoded;
}

export function encodeCwd(cwd: string): string {
  // Match Grok-style URL encoding of absolute path
  return encodeURIComponent(path.resolve(cwd));
}

export function projectLabel(cwd: string): string {
  const base = path.basename(cwd.replace(/[\\/]+$/, "")) || cwd;
  return base || cwd;
}

type SummaryJson = {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  num_messages?: number;
  current_model_id?: string;
  parent_session_id?: string | null;
  /** Grok marks spawned agents as subagent / subagent_fork / subagent_resume */
  session_kind?: string | null;
  agent_name?: string | null;
};

type SignalsJson = {
  contextTokensUsed?: number;
  sessionDurationSeconds?: number;
  totalTokensBeforeCompaction?: number;
};

/** Session kinds that are spawned by Grok (not human top-level chats). */
const SUBAGENT_KINDS = new Set([
  "subagent",
  "subagent_fork",
  "subagent_resume",
  "fork",
  "child",
]);

/**
 * True for top-level human chats. Filters Grok-spawned subagents / forks.
 */
export function isMainHumanSession(data: {
  session_kind?: string | null;
  parent_session_id?: string | null;
  generated_title?: string | null;
  session_summary?: string | null;
  agent_name?: string | null;
}): boolean {
  const kind = (data.session_kind || "").toLowerCase().trim();
  if (kind && SUBAGENT_KINDS.has(kind)) return false;
  if (data.parent_session_id) return false;

  // Titles that are clearly system prompts injected into child agents
  const title = (data.generated_title || data.session_summary || "").trim();
  if (/^You are (an? |the )/i.test(title)) return false;
  if (/^\*\*adversarial verifier\*\*/i.test(title)) return false;

  return true;
}

function readSummary(sessionDir: string): SessionSummary | null {
  const summaryPath = path.join(sessionDir, "summary.json");
  if (!fs.existsSync(summaryPath)) return null;
  try {
    const raw = fs.readFileSync(summaryPath, "utf8");
    const data = JSON.parse(raw) as SummaryJson;
    const id = data.info?.id ?? path.basename(sessionDir);
    const cwd = data.info?.cwd ?? "";
    const title =
      data.generated_title ||
      data.session_summary ||
      `Session ${id.slice(0, 8)}`;
    return {
      id,
      cwd,
      title,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
      modelId: data.current_model_id ?? null,
      numMessages: data.num_messages ?? 0,
      parentSessionId: data.parent_session_id ?? null,
      path: sessionDir,
    };
  } catch {
    return null;
  }
}

/**
 * List all projects (cwd groups) and sessions under a Grok home sessions tree.
 * Accepts an optional fs-like for tests.
 */
export function listProjects(
  grokHome: string,
  io: { readdirSync: typeof fs.readdirSync; existsSync: typeof fs.existsSync; readFileSync: typeof fs.readFileSync; statSync: typeof fs.statSync } = fs,
): ProjectInfo[] {
  const root = sessionsRoot(grokHome);
  if (!io.existsSync(root)) return [];

  const projects: ProjectInfo[] = [];
  let entries: string[] = [];
  try {
    entries = io.readdirSync(root) as string[];
  } catch {
    return [];
  }

  for (const encoded of entries) {
    if (encoded.startsWith(".")) continue;
    const groupDir = path.join(root, encoded);
    let isDir = false;
    try {
      isDir = io.statSync(groupDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const cwd = decodeEncodedCwd(encoded, groupDir);
    const sessions = listSessionsInGroup(groupDir, cwd, io);
    let lastUpdated: string | null = null;
    let firstActivity: string | null = null;
    let lastActivity: string | null = null;
    let totalTokens = 0;
    let totalDuration = 0;
    for (const s of sessions) {
      if (s.updatedAt && (!lastUpdated || s.updatedAt > lastUpdated)) {
        lastUpdated = s.updatedAt;
      }
      if (s.createdAt && (!firstActivity || s.createdAt < firstActivity)) {
        firstActivity = s.createdAt;
      }
      const act = s.updatedAt || s.createdAt;
      if (act && (!lastActivity || act > lastActivity)) {
        lastActivity = act;
      }
      totalTokens += s.tokensUsed || 0;
      totalDuration += s.durationSeconds || 0;
    }
    projects.push({
      id: encoded,
      cwd,
      label: projectLabel(cwd),
      encodedCwd: encoded,
      sessionCount: sessions.length,
      lastUpdated,
      totalTokens,
      totalDurationSeconds: totalDuration,
      firstActivityAt: firstActivity,
      lastActivityAt: lastActivity,
    });
  }

  projects.sort((a, b) => {
    const ta = a.lastUpdated ?? "";
    const tb = b.lastUpdated ?? "";
    return tb.localeCompare(ta);
  });
  return projects;
}

export function listSessionsInGroup(
  groupDir: string,
  cwdFallback: string,
  io: { readdirSync: typeof fs.readdirSync; existsSync: typeof fs.existsSync; readFileSync: typeof fs.readFileSync; statSync: typeof fs.statSync } = fs,
): SessionSummary[] {
  let entries: string[] = [];
  try {
    entries = io.readdirSync(groupDir) as string[];
  } catch {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const sessionDir = path.join(groupDir, name);
    try {
      if (!io.statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Use injected read for summary
    const summaryPath = path.join(sessionDir, "summary.json");
    if (!io.existsSync(summaryPath)) continue;
    try {
      const raw = io.readFileSync(summaryPath, "utf8");
      const data = JSON.parse(raw) as SummaryJson;
      // Sidebar: only human/main sessions — hide Grok-spawned subagents
      if (!isMainHumanSession(data)) continue;
      const id = data.info?.id ?? name;
      const cwd = data.info?.cwd ?? cwdFallback;

      let tokensUsed = 0;
      let durationSeconds = 0;
      const signalsPath = path.join(sessionDir, "signals.json");
      if (io.existsSync(signalsPath)) {
        try {
          const sig = JSON.parse(io.readFileSync(signalsPath, "utf8")) as SignalsJson;
          tokensUsed = Number(sig.contextTokensUsed || 0) || 0;
          durationSeconds = Number(sig.sessionDurationSeconds || 0) || 0;
        } catch {
          // ignore bad signals
        }
      }

      // Prefer last_active for "updated" display
      const updatedAt = data.last_active_at || data.updated_at || null;

      sessions.push({
        id,
        cwd,
        title: data.generated_title || data.session_summary || `Session ${id.slice(0, 8)}`,
        createdAt: data.created_at ?? null,
        updatedAt,
        modelId: data.current_model_id ?? null,
        numMessages: data.num_messages ?? 0,
        parentSessionId: data.parent_session_id ?? null,
        path: sessionDir,
        tokensUsed,
        durationSeconds,
      });
    } catch {
      continue;
    }
  }
  sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return sessions;
}

/** Format token counts for UI (e.g. 371183 → 371K). */
export function formatTokenCount(n: number): string {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format duration seconds as 1h 52m / 45m / 12s. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function listSessionsForCwd(grokHome: string, cwd: string): SessionSummary[] {
  const encoded = encodeCwd(cwd);
  const groupDir = path.join(sessionsRoot(grokHome), encoded);
  if (!fs.existsSync(groupDir)) {
    // Fallback: scan all projects for matching cwd
    const projects = listProjects(grokHome);
    const match = projects.find((p) => path.resolve(p.cwd) === path.resolve(cwd));
    if (!match) return [];
    return listSessionsInGroup(path.join(sessionsRoot(grokHome), match.encodedCwd), cwd);
  }
  return listSessionsInGroup(groupDir, cwd);
}

export function getSessionById(grokHome: string, sessionId: string): SessionSummary | null {
  const root = sessionsRoot(grokHome);
  if (!fs.existsSync(root)) return null;
  for (const encoded of fs.readdirSync(root)) {
    if (encoded.startsWith(".")) continue;
    const groupDir = path.join(root, encoded);
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const sessionDir = path.join(groupDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      return readSummary(sessionDir);
    }
  }
  return null;
}

/**
 * Load recent conversation stream items from updates.jsonl (best-effort for resume UI).
 */
export function loadSessionUpdatesJsonl(
  sessionPath: string,
  maxLines = 500,
): Array<Record<string, unknown>> {
  const file = path.join(sessionPath, "updates.jsonl");
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter(Boolean);
  const slice = lines.slice(-maxLines);
  const out: Array<Record<string, unknown>> = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip bad lines
    }
  }
  return out;
}

export function detectAuth(grokHome: string): {
  hasAuthFile: boolean;
  authPath: string;
  hasApiKey: boolean;
  loggedIn: boolean;
  method: "cli-session" | "api-key" | "none";
  message: string;
} {
  const authPath = path.join(grokHome, "auth.json");
  const hasAuthFile = fs.existsSync(authPath);
  let hasSession = false;
  if (hasAuthFile) {
    try {
      const raw = fs.readFileSync(authPath, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (data && typeof data === "object") {
        const keys = Object.keys(data as object);
        hasSession = keys.length > 0;
      }
    } catch {
      hasSession = false;
    }
  }
  const hasApiKey = Boolean(process.env.XAI_API_KEY && process.env.XAI_API_KEY.length > 0);
  if (hasSession) {
    return {
      hasAuthFile: true,
      authPath,
      hasApiKey,
      loggedIn: true,
      method: "cli-session",
      message: "Using Grok CLI session credentials (~/.grok/auth.json).",
    };
  }
  if (hasApiKey) {
    return {
      hasAuthFile,
      authPath,
      hasApiKey: true,
      loggedIn: true,
      method: "api-key",
      message: "Using XAI_API_KEY environment variable.",
    };
  }
  return {
    hasAuthFile,
    authPath,
    hasApiKey: false,
    loggedIn: false,
    method: "none",
    message:
      "Not signed in. Run `grok login` (SuperGrok or X Premium+) or set XAI_API_KEY.",
  };
}
