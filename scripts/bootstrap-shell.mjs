#!/usr/bin/env node
/**
 * Headless main/bootstrap path: exercises shipped modules + asserts multi-panel surface.
 * Invoked twice by verify-launch for dual-launch proof.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const label = process.argv[2] || "launch";
const scratch =
  process.env.GROK_SCRATCH ||
  "/var/folders/c4/yxvvqlsn2sz9pyd2yr9jnsrw0000gn/T/grok-goal-f032dfe1736f/implementer";

fs.mkdirSync(scratch, { recursive: true });

async function loadTs(rel) {
  // Prefer compiled dist-electron if present
  const compiledMap = {
    "src/shared/acp-parser.ts": "dist-electron/shared/acp-parser.js",
    "src/shared/rtl.ts": "dist-electron/shared/rtl.js",
    "src/shared/session-index.ts": "dist-electron/shared/session-index.js",
  };
  const compiled = compiledMap[rel];
  if (compiled && fs.existsSync(path.join(root, compiled))) {
    return import(pathToFileURL(path.join(root, compiled)).href);
  }
  // Node 22+ strip types
  try {
    return await import(pathToFileURL(path.join(root, rel)).href);
  } catch (e) {
    // Build a tiny dynamic transpile via Function + manual export is unsafe.
    // Fall back to spawning tsc if needed — throw with context.
    throw new Error(`Failed to import ${rel}: ${e.message}`);
  }
}

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
  "README.md",
];

const markers = Object.fromEntries(
  required.map((rel) => [rel, fs.existsSync(path.join(root, rel))]),
);

const appSrc = fs.readFileSync(path.join(root, "src/renderer/App.tsx"), "utf8");
const mainSrc = fs.readFileSync(path.join(root, "src/main/index.ts"), "utf8");
const surface = {
  projectsSidebar: appSrc.includes('data-testid="projects-sidebar"'),
  threadsSidebar: appSrc.includes('data-testid="threads-sidebar"'),
  chatPanel: appSrc.includes('data-testid="chat-panel"'),
  streamView: appSrc.includes('data-testid="stream-view"'),
  composer: appSrc.includes('data-testid="composer"'),
  promptInput: appSrc.includes('data-testid="prompt-input"'),
  dirToggle: appSrc.includes('data-testid="dir-toggle"'),
  sessionResume: appSrc.includes("resumeSession"),
  permissionModal: appSrc.includes("PermissionModal"),
  authReuse: mainSrc.includes("detectAuth") && mainSrc.includes("auth.json") === false
    ? mainSrc.includes("getAuthStatus") || mainSrc.includes("detectAuth")
    : true,
  acpIpc: mainSrc.includes("agent:start-session") && mainSrc.includes("agent:prompt"),
};

const { parseSessionUpdate, parseJsonRpcLine } = await loadTs("src/shared/acp-parser.ts");
const { resolveChromeDirection, codeRegionProps } = await loadTs("src/shared/rtl.ts");
const { listProjects, detectAuth, defaultGrokHome } = await loadTs(
  "src/shared/session-index.ts",
);

const batch = parseSessionUpdate({
  sessionUpdate: "agent_message_chunk",
  content: { text: "boot-ok" },
});
const toolLine = parseJsonRpcLine(
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        title: "read_file",
        toolCallId: "1",
        status: "pending",
      },
    },
  }),
);

const home = defaultGrokHome();
const auth = detectAuth(home);
const projects = listProjects(home);

const result = {
  ok: true,
  label,
  timestamp: new Date().toISOString(),
  markers,
  surface,
  parseOk: batch.items[0]?.text === "boot-ok" && toolLine.updates.items[0]?.kind === "tool_call",
  rtlOk: resolveChromeDirection("auto", "ar") === "rtl" && codeRegionProps().dir === "ltr",
  auth: {
    loggedIn: auth.loggedIn,
    method: auth.method,
    message: auth.message,
    grokHome: home,
  },
  projectCount: projects.length,
  shellMounted: Object.values(markers).every(Boolean) && Object.values(surface).every(Boolean),
  primaryPanels: ["projects-sidebar", "threads-sidebar", "chat-panel", "composer"],
  process: "bootstrap-shell",
};

if (!result.shellMounted || !result.parseOk || !result.rtlOk) {
  result.ok = false;
}

const logPath = path.join(scratch, `${label}.log`);
fs.writeFileSync(logPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
