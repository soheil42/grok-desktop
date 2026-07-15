/**
 * Resolve the Grok CLI binary path.
 *
 * Packaged Electron apps often have a stripped PATH, so bare `grok` fails with
 * ENOENT even when ~/.grok/bin/grok exists. Prefer absolute paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultGrokHome } from "./session-index.js";

function isExecutableFile(p: string): boolean {
  try {
    // stat follows symlinks (e.g. ~/.grok/bin/grok → downloads/…)
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    try {
      fs.accessSync(p, fs.constants.X_OK);
    } catch {
      // still allow if file exists — packaged env may differ on X_OK
    }
    return true;
  } catch {
    return false;
  }
}

/** Candidate absolute paths, in preference order. */
export function grokBinaryCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = os.homedir();
  const grokHome = defaultGrokHome(env);
  const fromEnv = env.GROK_BINARY?.trim();
  const pathDirs = (env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);

  const list: string[] = [];
  if (fromEnv) list.push(fromEnv);

  list.push(
    path.join(grokHome, "bin", "grok"),
    path.join(home, ".grok", "bin", "grok"),
    path.join(home, ".local", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
    "/usr/bin/grok",
  );

  for (const dir of pathDirs) {
    list.push(path.join(dir, "grok"));
  }

  // de-dupe
  return [...new Set(list)];
}

/**
 * Returns an absolute path to an executable `grok` binary, or `"grok"` as last resort.
 */
export function resolveGrokBinary(env: NodeJS.ProcessEnv = process.env): string {
  for (const candidate of grokBinaryCandidates(env)) {
    if (!candidate) continue;
    // Relative names (just "grok") only work if on PATH — try absolute ones first
    if (!path.isAbsolute(candidate) && candidate !== "grok") {
      // treat as relative to cwd — skip for safety
      continue;
    }
    if (path.isAbsolute(candidate) && isExecutableFile(candidate)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  // Last resort: hope PATH works (dev shells)
  return env.GROK_BINARY?.trim() || "grok";
}

/** PATH that includes ~/.grok/bin so child tools can find grok too. */
export function pathWithGrokBin(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  const extra = [
    path.join(defaultGrokHome(env), "bin"),
    path.join(home, ".grok", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  const parts = [...extra, ...current.split(path.delimiter)].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

export function formatGrokNotFoundError(triedBinary: string): string {
  const home = path.join(os.homedir(), ".grok", "bin", "grok");
  return (
    `Could not find the Grok CLI (tried: ${triedBinary}).\n` +
    `Install it and sign in:\n` +
    `  curl -fsSL https://x.ai/cli/install.sh | bash\n` +
    `  grok login\n` +
    `Expected at: ${home}\n` +
    `Or set GROK_BINARY to the full path.`
  );
}
