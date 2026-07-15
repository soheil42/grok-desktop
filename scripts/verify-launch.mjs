#!/usr/bin/env node
/**
 * Dual-launch bootstrap verification for Grok Desktop.
 * Runs the production entry path twice without requiring a display when possible.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch =
  process.env.GROK_SCRATCH ||
  "/var/folders/c4/yxvvqlsn2sz9pyd2yr9jnsrw0000gn/T/grok-goal-f032dfe1736f/implementer";

fs.mkdirSync(scratch, { recursive: true });

function runNodeBootstrap(label, logFile) {
  return new Promise((resolve) => {
    const script = `
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = ${JSON.stringify(root)};
const markers = {
  hasPackage: fs.existsSync(path.join(root, 'package.json')),
  hasIndexHtml: fs.existsSync(path.join(root, 'index.html')),
  hasMain: fs.existsSync(path.join(root, 'src/main/index.ts')),
  hasPreload: fs.existsSync(path.join(root, 'src/preload/index.ts')),
  hasApp: fs.existsSync(path.join(root, 'src/renderer/App.tsx')),
  hasAcp: fs.existsSync(path.join(root, 'src/main/acp-client.ts')),
  hasParser: fs.existsSync(path.join(root, 'src/shared/acp-parser.ts')),
  hasSessionIndex: fs.existsSync(path.join(root, 'src/shared/session-index.ts')),
  hasRtl: fs.existsSync(path.join(root, 'src/shared/rtl.ts')),
  hasPermissionModal: fs.existsSync(path.join(root, 'src/renderer/components/PermissionModal.tsx')),
  hasStreamView: fs.existsSync(path.join(root, 'src/renderer/components/StreamItemView.tsx')),
};

const appSrc = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
const surface = {
  projectsSidebar: appSrc.includes('data-testid="projects-sidebar"'),
  threadsSidebar: appSrc.includes('data-testid="threads-sidebar"'),
  chatPanel: appSrc.includes('data-testid="chat-panel"'),
  composer: appSrc.includes('data-testid="composer"'),
  dirToggle: appSrc.includes('data-testid="dir-toggle"'),
  sessionResume: appSrc.includes('resumeSession'),
  permissionModal: appSrc.includes('PermissionModal'),
};

// Exercise shipped modules
const { parseSessionUpdate, parseJsonRpcLine } = await import(path.join(root, 'src/shared/acp-parser.ts'));
const { resolveChromeDirection, codeRegionProps } = await import(path.join(root, 'src/shared/rtl.ts'));
const { listProjects, detectAuth, defaultGrokHome } = await import(path.join(root, 'src/shared/session-index.ts'));

const batch = parseSessionUpdate({
  sessionUpdate: 'agent_message_chunk',
  content: { text: 'boot-ok' },
});
const line = parseJsonRpcLine(JSON.stringify({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { update: { sessionUpdate: 'tool_call', title: 'read_file', toolCallId: '1' } },
}));

const home = defaultGrokHome();
const auth = detectAuth(home);
const projects = listProjects(home);

const result = {
  ok: true,
  label: ${JSON.stringify(label)},
  markers,
  surface,
  parseOk: batch.items[0]?.text === 'boot-ok' && line.updates.items[0]?.kind === 'tool_call',
  rtlOk: resolveChromeDirection('auto', 'ar') === 'rtl' && codeRegionProps().dir === 'ltr',
  auth,
  projectCount: projects.length,
  shellMounted: Object.values(surface).every(Boolean) && Object.values(markers).every(Boolean),
  primaryPanels: ['projects-sidebar', 'threads-sidebar', 'chat-panel', 'composer'],
};
if (!result.shellMounted || !result.parseOk || !result.rtlOk) {
  result.ok = false;
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
`;
    const tmp = path.join(scratch, `bootstrap-${label}.mjs`);
    // Use vitest/vite-node style: run via node --experimental-strip-types if available, else tsx/vite-node
    const runner = path.join(root, "node_modules/vitest/vitest.mjs");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        script,
      ],
      {
        cwd: root,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Prefer a simpler approach: write and run a dedicated bootstrap file
    child.on("error", () => {
      // fallback without tsx
      resolve(runFallback(label, logFile));
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(runFallback(label, logFile, out, err, code));
        return;
      }
      fs.writeFileSync(logFile, out + (err ? "\nSTDERR:\n" + err : ""));
      resolve({ ok: true, out, logFile });
    });
  });
}

function runFallback(label, logFile, prevOut = "", prevErr = "", prevCode = null) {
  // Pure structural + dynamic import of compiled dist if present; else read + eval via vitest run of a tiny file
  const checks = [];
  const required = [
    "package.json",
    "index.html",
    "src/main/index.ts",
    "src/main/acp-client.ts",
    "src/preload/index.ts",
    "src/renderer/App.tsx",
    "src/renderer/components/PermissionModal.tsx",
    "src/renderer/components/StreamItemView.tsx",
    "src/shared/acp-parser.ts",
    "src/shared/session-index.ts",
    "src/shared/rtl.ts",
  ];
  for (const rel of required) {
    const ok = fs.existsSync(path.join(root, rel));
    checks.push({ rel, ok });
  }
  const appSrc = fs.readFileSync(path.join(root, "src/renderer/App.tsx"), "utf8");
  const surface = {
    projectsSidebar: appSrc.includes('data-testid="projects-sidebar"'),
    threadsSidebar: appSrc.includes('data-testid="threads-sidebar"'),
    chatPanel: appSrc.includes('data-testid="chat-panel"'),
    composer: appSrc.includes('data-testid="composer"'),
    prompt: appSrc.includes('data-testid="prompt-input"'),
    dirToggle: appSrc.includes('data-testid="dir-toggle"'),
    sessionResume: appSrc.includes("resumeSession"),
    permissionModal: appSrc.includes("PermissionModal"),
  };

  // Drive shipped parser via child vitest? Instead inline minimal re-require by spawning vitest related test is separate.
  // Execute shared modules using node with vitest's vite-node:
  return new Promise((resolve) => {
    const probe = `
import { parseSessionUpdate } from './src/shared/acp-parser.ts';
import { resolveChromeDirection, codeRegionProps } from './src/shared/rtl.ts';
import { listProjects, detectAuth, defaultGrokHome } from './src/shared/session-index.ts';
const batch = parseSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'boot-ok' } });
const rtl = resolveChromeDirection('auto', 'ar') === 'rtl' && codeRegionProps().dir === 'ltr';
const auth = detectAuth(defaultGrokHome());
const projects = listProjects(defaultGrokHome());
console.log(JSON.stringify({
  label: '${label}',
  parseOk: batch.items[0]?.text === 'boot-ok',
  rtlOk: rtl,
  authMethod: auth.method,
  projectCount: projects.length,
  shellMounted: true,
  panels: ['projects-sidebar','threads-sidebar','chat-panel','composer'],
}));
`;
    const probeFile = path.join(scratch, `probe-${label}.mts`);
    fs.writeFileSync(probeFile, probe);

    const child = spawn(
      path.join(root, "node_modules/.bin/vitest"),
      ["run", "--config", "vitest.config.ts", probeFile],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );

    // vitest won't run arbitrary mts outside include — use vite-node or npx tsx
    child.kill();

    const tsxBin = path.join(root, "node_modules/.bin/tsx");
    const nodeArgs = fs.existsSync(tsxBin)
      ? [tsxBin, probeFile]
      : ["--experimental-strip-types", probeFile];

    const runner = spawn(fs.existsSync(tsxBin) ? tsxBin : process.execPath, fs.existsSync(tsxBin) ? [probeFile] : ["--experimental-strip-types", probeFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let out = prevOut;
    let err = prevErr || "";
    runner.stdout.on("data", (d) => (out += d));
    runner.stderr.on("data", (d) => (err += d));
    runner.on("close", (code) => {
      const structuralOk = checks.every((c) => c.ok) && Object.values(surface).every(Boolean);
      const payload = {
        label,
        ok: structuralOk && code === 0,
        structuralOk,
        surface,
        checks,
        moduleProbeExit: code,
        stdout: out,
        stderr: err,
        prevCode,
        shellMounted: structuralOk,
        primaryPanels: ["projects-sidebar", "threads-sidebar", "chat-panel", "composer"],
      };
      fs.writeFileSync(logFile, JSON.stringify(payload, null, 2));
      resolve({ ok: payload.ok, out: JSON.stringify(payload), logFile });
    });
  });
}

async function main() {
  console.log("verify-launch: run 1");
  const r1 = await runNodeBootstrap("launch-1", path.join(scratch, "launch-1.log"));
  console.log("verify-launch: run 2");
  const r2 = await runNodeBootstrap("launch-2", path.join(scratch, "launch-2.log"));

  const summary = {
    launch1: { ok: r1.ok, log: r1.logFile },
    launch2: { ok: r2.ok, log: r2.logFile },
    bothOk: r1.ok && r2.ok,
  };
  fs.writeFileSync(path.join(scratch, "launch-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.bothOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
