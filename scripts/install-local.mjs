#!/usr/bin/env node
/**
 * Install the packaged macOS .app into ~/Applications (and /Applications if writable).
 * Usage: npm run install:local   (after dist:mac)
 *        npm run dist:install    (build + install)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Grok Desktop.app";
const candidates = [
  path.join(root, "release", "mac-arm64", appName),
  path.join(root, "release", "mac", appName),
];

const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error(
    "No packaged app found. Run `npm run dist:mac` first.\nLooked in:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}

const dests = [path.join(os.homedir(), "Applications", appName)];
const systemApps = path.join("/Applications", appName);
// Only try /Applications if we can write (or already own an install)
try {
  fs.accessSync("/Applications", fs.constants.W_OK);
  dests.push(systemApps);
} catch {
  // skip system Applications
}

function installTo(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  try {
    execSync(`xattr -cr ${JSON.stringify(dest)}`, { stdio: "ignore" });
  } catch {
    // ignore quarantine clear failures
  }
  console.log("Installed →", dest);
}

// Best-effort quit
try {
  execSync('osascript -e \'tell application "Grok Desktop" to quit\'', {
    stdio: "ignore",
  });
} catch {
  // not running
}

for (const dest of dests) {
  try {
    installTo(dest);
  } catch (e) {
    console.warn("Failed", dest, e instanceof Error ? e.message : e);
  }
}

const homeDest = dests[0];
if (fs.existsSync(homeDest) && process.env.GROK_DESKTOP_NO_OPEN !== "1") {
  spawn("open", ["-a", homeDest], { detached: true, stdio: "ignore" }).unref();
}
