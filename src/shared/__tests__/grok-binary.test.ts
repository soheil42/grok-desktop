import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  formatGrokNotFoundError,
  grokBinaryCandidates,
  pathWithGrokBin,
  resolveGrokBinary,
} from "../grok-binary";

describe("resolveGrokBinary", () => {
  it("prefers GROK_BINARY when it points at an existing file", () => {
    const real = path.join(os.homedir(), ".grok", "bin", "grok");
    if (!fs.existsSync(real)) return; // skip if CLI not installed in CI
    const resolved = resolveGrokBinary({
      ...process.env,
      GROK_BINARY: real,
    });
    expect(resolved.length).toBeGreaterThan(1);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it("lists ~/.grok/bin/grok among candidates", () => {
    const c = grokBinaryCandidates({ PATH: "/usr/bin" });
    expect(c.some((p) => p.endsWith(path.join(".grok", "bin", "grok")))).toBe(
      true,
    );
  });

  it("pathWithGrokBin prepends grok bin dirs", () => {
    const p = pathWithGrokBin({ PATH: "/usr/bin" });
    expect(p.includes(path.join(".grok", "bin"))).toBe(true);
    expect(p.endsWith("/usr/bin") || p.includes("/usr/bin")).toBe(true);
  });

  it("formatGrokNotFoundError mentions install", () => {
    const msg = formatGrokNotFoundError("grok");
    expect(msg).toMatch(/Could not find the Grok CLI/);
    expect(msg).toMatch(/grok login/);
  });
});
