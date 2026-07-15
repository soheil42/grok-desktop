import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeImage,
  type OpenDialogOptions,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokAcpClient } from "./acp-client.js";
import {
  defaultGrokHome,
  detectAuth,
  listProjects,
  listSessionsForCwd,
  getSessionById,
  loadSessionUpdatesJsonl,
} from "../shared/session-index.js";
import { parseSessionUpdate } from "../shared/acp-parser.js";
import { prepareHistoryItems } from "../shared/stream-timeline.js";
import {
  attachImagesToHistory,
  fileToDataUrl,
} from "../shared/history-images.js";
import { deleteSessionTree } from "../shared/session-delete.js";
import {
  buildExitPlanModeExtResult,
  planDecisionToOptionId,
} from "../shared/plan-approval.js";
import {
  askQuestionsAllowOptionId,
  askQuestionsRejectOptionId,
  buildAskUserQuestionResult,
  buildSkipInterviewResult,
} from "../shared/user-questions.js";
import type {
  AuthStatus,
  PermissionRequest,
  StreamItem,
} from "../shared/types.js";
import { preserveJsonRpcId } from "../shared/types.js";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged && Boolean(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL);

type ThreadBinding = {
  client: GrokAcpClient;
  sessionId: string | null;
  cwd: string;
  windowId: number;
};

const bindings = new Map<string, ThreadBinding>();
let mainWindow: BrowserWindow | null = null;

function grokHome(): string {
  return process.env.GROK_HOME?.trim() || defaultGrokHome();
}

/** Absolute path to the Grok app icon (png preferred for dock.setIcon). */
function resolveAppIconPath(): string {
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, "icons", "icon.png"),
        path.join(process.resourcesPath, "icons", "icon-512.png"),
        path.join(process.resourcesPath, "icons", "icon.icns"),
      ]
    : [
        path.join(__dirname, "../../resources/icons/icon.png"),
        path.join(__dirname, "../../resources/icons/icon-512.png"),
        path.join(__dirname, "../../resources/icons/icon-1024.png"),
        path.join(__dirname, "../../resources/icons/icon.icns"),
      ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // try next
    }
  }
  return candidates[0];
}

/**
 * macOS dock ignores BrowserWindow `icon` when running `electron .` — it shows
 * the Electron atom unless we set dock icon explicitly. Packaged apps use .icns.
 */
function applyAppIcon(): void {
  const iconPath = resolveAppIconPath();
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.warn("[grok-desktop] icon empty:", iconPath);
      return;
    }
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(image);
    }
  } catch (e) {
    console.warn("[grok-desktop] failed to set dock icon:", e);
  }
}

function createWindow(): BrowserWindow {
  const iconPath = resolveAppIconPath();
  const iconImage = nativeImage.createFromPath(iconPath);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Grok Desktop",
    backgroundColor: "#050505",
    // Windows/Linux window icon; macOS dock handled by applyAppIcon()
    icon: iconImage.isEmpty() ? iconPath : iconImage,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  win.once("ready-to-show", () => {
    // Re-apply dock icon when window shows (dev `electron .` often resets it)
    applyAppIcon();
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl =
    process.env.VITE_DEV_SERVER_URL ||
    process.env.ELECTRON_RENDERER_URL ||
    "http://127.0.0.1:5173";

  if (isDev || process.env.GROK_DESKTOP_DEV === "1") {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  mainWindow = win;
  return win;
}

function sendToThreadWindow(threadId: string, channel: string, payload: unknown): void {
  const binding = bindings.get(threadId);
  if (!binding) {
    // broadcast to all windows
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(channel, { threadId, ...((payload as object) || {}) });
    }
    return;
  }
  const win = BrowserWindow.fromId(binding.windowId);
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, { threadId, ...(payload as object) });
  }
}

function getAuthStatus(): AuthStatus {
  const home = grokHome();
  const d = detectAuth(home);
  return {
    loggedIn: d.loggedIn,
    method: d.method,
    grokHome: home,
    authPath: d.authPath,
    hasAuthFile: d.hasAuthFile,
    message: d.message,
  };
}

async function ensureClient(
  threadId: string,
  cwd: string,
  win: BrowserWindow,
  opts?: { alwaysApprove?: boolean },
): Promise<ThreadBinding> {
  let binding = bindings.get(threadId);
  if (binding?.client.isRunning) {
    return binding;
  }
  if (binding) {
    await binding.client.dispose().catch(() => undefined);
  }

  const client = new GrokAcpClient({
    cwd,
    binary: process.env.GROK_BINARY || "grok",
    alwaysApprove:
      opts?.alwaysApprove === true ||
      process.env.GROK_DESKTOP_ALWAYS_APPROVE === "1",
  });

  binding = { client, sessionId: null, cwd, windowId: win.id };
  bindings.set(threadId, binding);

  client.on("update", (u) => {
    const permission = u.permission
      ? { ...u.permission, threadId }
      : null;
    const planApproval = u.planApproval
      ? { ...u.planApproval, threadId }
      : null;
    const userQuestions = u.userQuestions
      ? { ...u.userQuestions, threadId }
      : null;
    sendToThreadWindow(threadId, "agent:update", {
      sessionId: u.sessionId,
      items: u.items,
      permission,
      planApproval,
      userQuestions,
    });
  });

  client.on("permission", (req: PermissionRequest) => {
    // Stamp threadId so the renderer responds on the correct GrokAcpClient binding.
    const stamped: PermissionRequest = { ...req, threadId };
    sendToThreadWindow(threadId, "agent:permission", { permission: stamped });
  });

  client.on("planApproval", (req) => {
    const stamped = { ...req, threadId };
    sendToThreadWindow(threadId, "agent:plan-approval", {
      planApproval: stamped,
    });
  });

  client.on("userQuestions", (req) => {
    const stamped = { ...req, threadId };
    sendToThreadWindow(threadId, "agent:user-questions", {
      userQuestions: stamped,
    });
  });

  client.on("error", (err: Error) => {
    sendToThreadWindow(threadId, "agent:error", { message: err.message });
  });

  client.on("log", (line: string) => {
    sendToThreadWindow(threadId, "agent:log", { line });
  });

  client.on("exit", (code) => {
    sendToThreadWindow(threadId, "agent:exit", { code });
  });

  await client.start();
  return binding;
}

function registerIpc(): void {
  ipcMain.handle("app:get-bootstrap", async () => {
    return {
      platform: process.platform,
      version: app.getVersion(),
      auth: getAuthStatus(),
      grokHome: grokHome(),
      shellMounted: true,
    };
  });

  ipcMain.handle("auth:status", async () => getAuthStatus());

  ipcMain.handle("auth:open-login-hint", async () => {
    return {
      command: "grok login",
      message:
        "Sign in with the same SuperGrok / X Premium+ account used by Grok CLI. Run `grok login` in a terminal, then click Refresh.",
    };
  });

  ipcMain.handle("projects:list", async () => {
    return listProjects(grokHome());
  });

  ipcMain.handle("sessions:list", async (_e, cwd: string) => {
    return listSessionsForCwd(grokHome(), cwd);
  });

  ipcMain.handle("sessions:get", async (_e, sessionId: string) => {
    return getSessionById(grokHome(), sessionId);
  });

  ipcMain.handle(
    "sessions:delete",
    async (
      _e,
      payload: { sessionId?: string; sessionPath?: string },
    ) => {
      return deleteSessionTree(grokHome(), payload);
    },
  );

  ipcMain.handle("sessions:load-history", async (_e, sessionPath: string) => {
    // Read a bounded tail of the session log (long sessions are 10k+ lines).
    const lines = loadSessionUpdatesJsonl(sessionPath, 900);
    const items: StreamItem[] = [];
    const skipSu = new Set([
      "hook_execution",
      "available_commands_update",
      "turn_completed",
      "goal_updated",
      "current_mode_update",
      "image_compressed",
      "session_recap",
      "task_backgrounded",
      "task_completed",
      "subagent_spawned",
      "subagent_finished",
    ]);
    for (const line of lines) {
      const method = String((line as { method?: string }).method || "");
      if (
        method.includes("hook") ||
        method.includes("mcp/") ||
        method.includes("announcements") ||
        method.includes("queue/") ||
        method.includes("sessions/changed") ||
        method.includes("models/") ||
        method.includes("settings/")
      ) {
        continue;
      }
      const params = (line.params as Record<string, unknown>) || line;
      const update =
        (params.update as Record<string, unknown>) ||
        (line.update as Record<string, unknown>) ||
        params;
      const su = String(
        (update as { sessionUpdate?: string }).sessionUpdate || "",
      );
      if (skipSu.has(su)) continue;
      // Skip in-progress-only tool updates without title/output (merge uses final)
      if (su === "tool_call_update") {
        const st = String((update as { status?: string }).status || "");
        const hasTitle = Boolean((update as { title?: string }).title);
        const hasOut =
          (update as { rawOutput?: unknown }).rawOutput != null ||
          (update as { content?: unknown }).content != null;
        if (!hasTitle && !hasOut && st !== "completed" && st !== "failed") {
          continue;
        }
      }
      const batch = parseSessionUpdate(update as never);
      items.push(...batch.items);
    }
    // Fully prepare once in main — single JSON blob, single React paint.
    let prepared = prepareHistoryItems(items, 180);
    // Attach screenshots from chat_history + session assets/images
    prepared = attachImagesToHistory(prepared, sessionPath);
    // Inline small images as data URLs so renderer can display without file:// CSP issues
    const home = grokHome();
    prepared = prepared.map((it) => {
      if (!it.images?.length) return it;
      return {
        ...it,
        images: it.images.map((im) => {
          if (im.dataUrl) return im;
          if (im.path) {
            const dataUrl = fileToDataUrl(im.path, home);
            if (dataUrl) return { ...im, dataUrl };
          }
          return im;
        }),
      };
    });
    return prepared;
  });

  /** Resolve an image path under GROK_HOME to a data URL for the renderer. */
  ipcMain.handle("media:read", async (_e, filePath: string) => {
    return fileToDataUrl(filePath, grokHome());
  });

  ipcMain.handle("dialog:open-directory", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "agent:start-session",
    async (
      e,
      payload: {
        threadId: string;
        cwd: string;
        sessionId?: string;
        alwaysApprove?: boolean;
      },
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win) throw new Error("No window");
      const binding = await ensureClient(payload.threadId, payload.cwd, win, {
        alwaysApprove: payload.alwaysApprove,
      });
      let sessionId: string;
      if (payload.sessionId) {
        sessionId = await binding.client.loadSession(payload.sessionId, payload.cwd);
      } else {
        sessionId = await binding.client.newSession(payload.cwd);
      }
      binding.sessionId = sessionId;
      binding.cwd = payload.cwd;
      return { sessionId };
    },
  );

  ipcMain.handle(
    "agent:prompt",
    async (e, payload: { threadId: string; text: string; sessionId?: string }) => {
      const binding = bindings.get(payload.threadId);
      if (!binding) throw new Error("Agent not started for thread");
      const sid = payload.sessionId || binding.sessionId;
      if (!sid) throw new Error("No session");
      // Fire and wait for prompt RPC to complete (streams arrive via events)
      const result = await binding.client.prompt(payload.text, sid);
      return { result, sessionId: sid };
    },
  );

  ipcMain.handle(
    "agent:cancel",
    async (_e, payload: { threadId: string }) => {
      const binding = bindings.get(payload.threadId);
      if (!binding) return { ok: true };
      await binding.client.cancel();
      return { ok: true };
    },
  );

  ipcMain.handle(
    "agent:permission-response",
    async (
      _e,
      payload: {
        threadId: string;
        requestId: string | number;
        optionId: string;
        allow: boolean;
      },
    ) => {
      const binding = bindings.get(payload.threadId);
      if (!binding) throw new Error("No agent");
      // Preserve JSON-RPC id type so the agent can match its pending request.
      const requestId = preserveJsonRpcId(payload.requestId);
      const optionId = payload.allow
        ? payload.optionId || "allow-once"
        : payload.optionId || "reject-once";
      binding.client.respond(requestId, {
        outcome: {
          outcome: "selected",
          optionId,
        },
      });
      return { ok: true, requestId, requestIdType: typeof requestId };
    },
  );

  ipcMain.handle(
    "agent:plan-response",
    async (
      _e,
      payload: {
        threadId: string;
        requestId: string | number;
        decision: "approved" | "rejected" | "abandoned";
        feedback?: string;
        source: "permission" | "ext_method";
        optionId?: string;
      },
    ) => {
      const binding = bindings.get(payload.threadId);
      if (!binding) throw new Error("No agent");
      const requestId = preserveJsonRpcId(payload.requestId);

      if (payload.source === "ext_method") {
        binding.client.respond(
          requestId,
          buildExitPlanModeExtResult(payload.decision, payload.feedback),
        );
      } else {
        const optionId =
          payload.optionId ||
          planDecisionToOptionId(payload.decision, undefined);
        binding.client.respond(requestId, {
          outcome: {
            outcome: "selected",
            optionId,
          },
        });
      }
      return { ok: true, requestId, requestIdType: typeof requestId };
    },
  );

  ipcMain.handle(
    "agent:questions-response",
    async (
      _e,
      payload: {
        threadId: string;
        requestId: string | number;
        source: "permission" | "ext_method" | "tool_stream";
        answers: Record<string, string | string[]>;
        notes?: Record<string, string>;
        questions: Array<{
          id: string;
          question: string;
          options: Array<{ id: string; label: string }>;
          multiSelect?: boolean;
        }>;
        skip?: boolean;
      },
    ) => {
      const binding = bindings.get(payload.threadId);
      if (!binding) throw new Error("No agent");
      const requestId = preserveJsonRpcId(payload.requestId);

      if (payload.skip) {
        if (payload.source === "permission") {
          binding.client.respond(requestId, {
            outcome: {
              outcome: "selected",
              optionId: askQuestionsRejectOptionId(),
            },
          });
        } else {
          // Pure enum — no extra keys
          binding.client.respond(requestId, buildSkipInterviewResult());
        }
        return { ok: true };
      }

      // Ignore synthetic pending-* ids — no live JSON-RPC request.
      if (String(payload.requestId).startsWith("pending-")) {
        return { ok: false, error: "no live request id yet" };
      }

      // Pure { Accepted: { answers: { q: ["label"] } } } — extra keys break Grok.
      const result = buildAskUserQuestionResult(
        payload.questions,
        payload.answers,
        payload.notes,
      );

      if (payload.source === "permission") {
        // Permission with embedded form: allow tool + attach Accepted payload
        binding.client.respond(requestId, {
          outcome: {
            outcome: "selected",
            optionId: askQuestionsAllowOptionId(),
          },
          result,
        });
      } else {
        binding.client.respond(requestId, result);
      }
      return { ok: true, requestId, requestIdType: typeof requestId, result };
    },
  );

  ipcMain.handle(
    "sessions:read-plan",
    async (
      _e,
      payload: { sessionId?: string; sessionPath?: string; planFilePath?: string },
    ) => {
      const candidates: string[] = [];
      if (payload.planFilePath) candidates.push(payload.planFilePath);
      if (payload.sessionPath) {
        candidates.push(
          path.join(payload.sessionPath, "plan.md"),
          path.join(payload.sessionPath, "goal", "plan.md"),
        );
      }
      if (payload.sessionId) {
        const session = getSessionById(grokHome(), payload.sessionId);
        if (session?.path) {
          candidates.push(
            path.join(session.path, "plan.md"),
            path.join(session.path, "goal", "plan.md"),
          );
        }
      }
      for (const file of candidates) {
        try {
          if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            const content = fs.readFileSync(file, "utf8");
            return { ok: true, path: file, content };
          }
        } catch {
          // try next
        }
      }
      return { ok: false, content: "", path: null as string | null };
    },
  );

  ipcMain.handle("agent:dispose", async (_e, threadId: string) => {
    const binding = bindings.get(threadId);
    if (binding) {
      await binding.client.dispose();
      bindings.delete(threadId);
    }
    return { ok: true };
  });

  ipcMain.handle("shell:open-external", async (_e, url: string) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("shell:open-path", async (_e, p: string) => {
    await shell.openPath(p);
    return { ok: true };
  });
}

/** Export for headless bootstrap verification without GUI when needed */
export function getMainModuleMarkers() {
  return {
    hasCreateWindow: typeof createWindow === "function",
    hasRegisterIpc: typeof registerIpc === "function",
    productName: "Grok Desktop",
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Name shown in menu bar / force-quit (not "Electron")
  app.setName("Grok Desktop");
  if (process.platform === "darwin") {
    try {
      // Optional About panel — not on all Electron type versions
      (
        app as unknown as {
          setAboutPanelParameters?: (opts: Record<string, string>) => void;
        }
      ).setAboutPanelParameters?.({
        applicationName: "Grok Desktop",
        applicationVersion: app.getVersion(),
        copyright: "Not an official xAI product",
      });
    } catch {
      // ignore
    }
  }

  app.whenReady().then(() => {
    applyAppIcon();
    registerIpc();
    createWindow();
    // Dev: Electron may overwrite dock after ready — set again next tick
    setTimeout(() => applyAppIcon(), 50);
    setTimeout(() => applyAppIcon(), 500);
    app.on("activate", () => {
      applyAppIcon();
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    for (const [, b] of bindings) {
      void b.client.dispose();
    }
    bindings.clear();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    for (const [, b] of bindings) {
      void b.client.dispose();
    }
    bindings.clear();
  });
}
