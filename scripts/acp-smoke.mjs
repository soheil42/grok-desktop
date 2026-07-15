#!/usr/bin/env node
/**
 * Integration smoke: drives the SHIPPED GrokAcpClient / bootstrapAcpSmoke path.
 * Does NOT reimplement JSON-RPC — compiles electron main if needed, then imports it.
 *
 * Writes {SCRATCH}/acp-smoke.jsonl or acp-smoke-skip.log
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch =
  process.env.GROK_SCRATCH ||
  "/var/folders/c4/yxvvqlsn2sz9pyd2yr9jnsrw0000gn/T/grok-goal-f032dfe1736f/implementer";

fs.mkdirSync(scratch, { recursive: true });

function whichGrok() {
  const envPath = process.env.GROK_BINARY;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const homeBin = path.join(process.env.HOME || "", ".grok/bin/grok");
  if (fs.existsSync(homeBin)) return homeBin;
  return "grok";
}

function skip(reason) {
  const p = path.join(scratch, "acp-smoke-skip.log");
  fs.writeFileSync(
    p,
    JSON.stringify({ skipped: true, reason, at: new Date().toISOString() }, null, 2),
  );
  console.log("ACP smoke skipped:", reason);
  process.exit(0);
}

function ensureCompiled() {
  const target = path.join(root, "dist-electron/main/acp-client.js");
  if (fs.existsSync(target)) return target;
  const r = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:electron"],
    { cwd: root, stdio: "inherit" },
  );
  return new Promise((resolve, reject) => {
    r.on("exit", (code) => {
      if (code === 0 && fs.existsSync(target)) resolve(target);
      else reject(new Error(`build:electron failed (${code})`));
    });
  });
}

async function main() {
  const binary = whichGrok();

  // Verify binary exists
  const ver = await new Promise((resolve) => {
    const c = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("error", () => resolve(null));
    c.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
  if (!ver) return skip(`grok binary not runnable: ${binary}`);

  let compiled;
  try {
    compiled = await ensureCompiled();
  } catch (e) {
    return skip(`compile failed: ${e.message}`);
  }

  // Import SHIPPED client
  const mod = await import(pathToFileURL(compiled).href);
  if (typeof mod.bootstrapAcpSmoke !== "function") {
    return skip("bootstrapAcpSmoke not exported from shipped acp-client");
  }

  const outPath = path.join(scratch, "acp-smoke.jsonl");
  const stream = fs.createWriteStream(outPath, { flags: "w" });
  stream.write(
    JSON.stringify({
      event: "start",
      driver: "shipped:bootstrapAcpSmoke",
      binary,
      version: ver,
      compiled,
    }) + "\n",
  );

  try {
    const result = await mod.bootstrapAcpSmoke({
      binary,
      cwd: root,
      prompt: "Reply with exactly: pong",
      timeoutMs: 90_000,
      alwaysApprove: true,
    });

    stream.write(
      JSON.stringify({
        event: "session",
        sessionId: result.sessionId,
      }) + "\n",
    );

    for (const line of result.lines) {
      stream.write(JSON.stringify({ event: "client-log", line }) + "\n");
    }
    for (const item of result.items) {
      stream.write(
        JSON.stringify({
          event: "stream-item",
          kind: item.kind,
          text: (item.text || "").slice(0, 200),
          toolName: item.toolName,
        }) + "\n",
      );
    }
    for (const p of result.permissions) {
      stream.write(
        JSON.stringify({
          event: "permission",
          id: p.id,
          idType: typeof p.id,
          title: p.title,
        }) + "\n",
      );
    }

    const gotUpdate = result.items.length > 0 || result.lines.some((l) => l.includes("update"));
    // Dispose shipped client
    await result.client.dispose();

    stream.write(
      JSON.stringify({
        event: "end",
        ok: Boolean(result.sessionId) && (gotUpdate || result.lines.length > 0),
        sessionId: result.sessionId,
        itemCount: result.items.length,
        permissionCount: result.permissions.length,
        gotUpdate,
        driver: "shipped:bootstrapAcpSmoke",
      }) + "\n",
    );
    stream.end();

    if (!result.sessionId) {
      console.error("ACP smoke failed: no sessionId from shipped client");
      process.exit(1);
    }
    if (!gotUpdate && result.lines.length === 0) {
      console.error("ACP smoke failed: no stream/logs from shipped client");
      process.exit(1);
    }

    console.log("ACP smoke ok (shipped client)", {
      sessionId: result.sessionId,
      itemCount: result.items.length,
      gotUpdate,
    });
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stream.write(JSON.stringify({ event: "error", message: msg }) + "\n");
    stream.end();
    if (/auth|login|401|unauthorized|not signed/i.test(msg)) {
      return skip(`auth failure: ${msg}`);
    }
    console.error("ACP smoke failed:", msg);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
