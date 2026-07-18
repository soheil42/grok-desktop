#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch =
  process.env.GROK_SCRATCH ||
  path.join(os.tmpdir(), "grok-desktop-audit");

const files = {
  projects: "src/renderer/App.tsx",
  threads: "src/renderer/App.tsx",
  stream: "src/renderer/components/StreamItemView.tsx",
  permission: "src/renderer/components/PermissionModal.tsx",
  resume: "src/renderer/store.ts",
  auth: "src/shared/session-index.ts",
  acp: "src/main/acp-client.ts",
  ipc: "src/main/index.ts",
  rtl: "src/shared/rtl.ts",
  readme: "README.md",
  package: "package.json",
};

const checks = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

for (const [name, rel] of Object.entries(files)) {
  checks.push({ name: `exists:${name}`, ok: fs.existsSync(path.join(root, rel)), rel });
}

const app = read("src/renderer/App.tsx");
const store = read("src/renderer/store.ts");
const main = read("src/main/index.ts");
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");

const assertions = [
  ["multi-project sidebar", app.includes("projects-sidebar")],
  ["thread list", app.includes("threads-sidebar")],
  ["chat/tool stream", app.includes("stream-view") && fs.existsSync(path.join(root, files.stream))],
  ["permission surface", app.includes("PermissionPrompt")],
  ["diff/tool results", read("src/renderer/components/StreamItemView.tsx").includes("diff-view")],
  ["session resume", store.includes("resumeSession") && store.includes("loadSessionHistory")],
  ["auth CLI reuse", main.includes("detectAuth") && read("src/shared/session-index.ts").includes("auth.json")],
  [
    "RTL support",
    app.includes("detectTextDirection") &&
      app.includes("shellDocumentAttrs") &&
      read("src/shared/rtl.ts").includes("detectTextDirection"),
  ],
  ["production build script", Boolean(pkg.scripts?.dist || pkg.scripts?.build)],
  ["README auth requirements", /SuperGrok|Premium\+|grok login/i.test(readme)],
  ["ACP client path", main.includes("GrokAcpClient") || main.includes("agent:start-session")],
];

for (const [name, ok] of assertions) {
  checks.push({ name, ok: Boolean(ok) });
}

const result = {
  ok: checks.every((c) => c.ok),
  checks,
  scripts: pkg.scripts,
};
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, "structural-audit.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
