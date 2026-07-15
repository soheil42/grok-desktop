#!/usr/bin/env node
/**
 * Install the packaged macOS .app into ~/Applications (and /Applications if writable).
 *
 * IMPORTANT: Must preserve relative framework symlinks. Node's fs.cpSync resolves
 * them to absolute paths by default, which breaks Electron (icudtl.dat not found)
 * and makes the app quit immediately. Use `ditto` instead.
 *
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
try {
  fs.accessSync("/Applications", fs.constants.W_OK);
  dests.push(path.join("/Applications", appName));
} catch {
  // skip system Applications
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy .app bundle preserving relative symlinks inside Electron Framework.
 * `ditto` is the reliable macOS tool for this (cp/fs.cpSync break frameworks).
 */
function installTo(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  execSync(`ditto ${shellQuote(src)} ${shellQuote(dest)}`, { stdio: "inherit" });
  try {
    execSync(`xattr -cr ${shellQuote(dest)}`, { stdio: "ignore" });
  } catch {
    // ignore quarantine clear failures
  }

  // Sanity: framework symlink must stay relative
  const fw = path.join(
    dest,
    "Contents/Frameworks/Electron Framework.framework/Electron Framework",
  );
  try {
    const link = fs.readlinkSync(fw);
    if (path.isAbsolute(link)) {
      console.warn(
        "WARNING: Electron Framework symlink is absolute — install may be broken:",
        link,
      );
    } else {
      console.log("Framework symlink OK:", link);
    }
  } catch (e) {
    console.warn("Could not verify framework symlink:", e.message);
  }

  // icudtl.dat must resolve
  const icu = path.join(
    dest,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/icudtl.dat",
  );
  if (!fs.existsSync(icu)) {
    throw new Error(`Missing icudtl.dat after install: ${icu}`);
  }
  console.log("Installed →", dest);
}

// Best-effort quit running instance
try {
  execSync('osascript -e \'tell application "Grok Desktop" to quit\'', {
    stdio: "ignore",
  });
  // give it a moment to release SingletonLock
  execSync("sleep 1");
} catch {
  // not running
}

// Clear stale single-instance locks if present
const userData = path.join(
  os.homedir(),
  "Library/Application Support/grok-desktop",
);
for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
  try {
    fs.rmSync(path.join(userData, name), { force: true });
  } catch {
    // ignore
  }
}

for (const dest of dests) {
  try {
    installTo(dest);
  } catch (e) {
    console.warn("Failed", dest, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

const homeDest = dests[0];
if (fs.existsSync(homeDest) && process.env.GROK_DESKTOP_NO_OPEN !== "1") {
  spawn("open", ["-a", homeDest], { detached: true, stdio: "ignore" }).unref();
}
