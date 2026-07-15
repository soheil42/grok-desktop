import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type DesktopApi = {
  getBootstrap: () => Promise<{
    platform: string;
    version: string;
    auth: {
      loggedIn: boolean;
      method: string;
      grokHome: string;
      authPath: string;
      hasAuthFile: boolean;
      message: string;
    };
    grokHome: string;
    shellMounted: boolean;
  }>;
  getAuthStatus: () => Promise<{
    loggedIn: boolean;
    method: string;
    grokHome: string;
    authPath: string;
    hasAuthFile: boolean;
    message: string;
  }>;
  openLoginHint: () => Promise<{ command: string; message: string }>;
  listProjects: () => Promise<unknown[]>;
  listSessions: (cwd: string) => Promise<unknown[]>;
  getSession: (sessionId: string) => Promise<unknown>;
  loadSessionHistory: (sessionPath: string) => Promise<unknown[]>;
  deleteSession: (payload: {
    sessionId?: string;
    sessionPath?: string;
  }) => Promise<{ ok: boolean; deleted: string[]; error?: string }>;
  openDirectory: () => Promise<string | null>;
  startSession: (payload: {
    threadId: string;
    cwd: string;
    sessionId?: string;
    alwaysApprove?: boolean;
  }) => Promise<{ sessionId: string }>;
  prompt: (payload: {
    threadId: string;
    text: string;
    sessionId?: string;
  }) => Promise<unknown>;
  cancel: (payload: { threadId: string }) => Promise<unknown>;
  respondPermission: (payload: {
    threadId: string;
    requestId: string | number;
    optionId: string;
    allow: boolean;
  }) => Promise<unknown>;
  respondPlan: (payload: {
    threadId: string;
    requestId: string | number;
    decision: "approved" | "rejected" | "abandoned";
    feedback?: string;
    source: "permission" | "ext_method";
    optionId?: string;
  }) => Promise<unknown>;
  respondQuestions: (payload: {
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
  }) => Promise<unknown>;
  readPlan: (payload: {
    sessionId?: string;
    sessionPath?: string;
    planFilePath?: string;
  }) => Promise<{ ok: boolean; content: string; path: string | null }>;
  disposeAgent: (threadId: string) => Promise<unknown>;
  setAgentMode: (payload: {
    threadId: string;
    mode: "agent" | "plan" | "auto";
    sessionId?: string;
  }) => Promise<{ ok: boolean; modeId?: string; alwaysApprove?: boolean }>;
  listRewindPoints: (payload: {
    threadId: string;
    sessionId?: string;
  }) => Promise<{
    points: Array<{
      prompt_index: number;
      created_at?: string;
      num_file_snapshots?: number;
      has_file_changes?: boolean;
      prompt_preview?: string;
    }>;
  }>;
  executeRewind: (payload: {
    threadId: string;
    sessionId?: string;
    targetPromptIndex: number;
    mode?: "all" | "conversation_only" | "code_only" | "files_only";
  }) => Promise<{
    success?: boolean;
    target_prompt_index?: number;
    mode?: string;
    reverted_files?: string[];
    prompt_text?: string | null;
    error?: string | null;
  }>;
  forkSession: (payload: {
    threadId: string;
    sessionId?: string;
    cwd?: string;
    directive?: string;
  }) => Promise<{
    newSessionId: string;
    parentSessionId?: string;
    newCwd?: string;
    chatMessagesCopied?: number;
  }>;
  openExternal: (url: string) => Promise<unknown>;
  openPath: (path: string) => Promise<unknown>;
  readMedia: (filePath: string) => Promise<string | null>;
  on: (
    channel: string,
    listener: (payload: unknown) => void,
  ) => () => void;
};

const api: DesktopApi = {
  getBootstrap: () => ipcRenderer.invoke("app:get-bootstrap"),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  openLoginHint: () => ipcRenderer.invoke("auth:open-login-hint"),
  listProjects: () => ipcRenderer.invoke("projects:list"),
  listSessions: (cwd) => ipcRenderer.invoke("sessions:list", cwd),
  getSession: (sessionId) => ipcRenderer.invoke("sessions:get", sessionId),
  loadSessionHistory: (sessionPath) =>
    ipcRenderer.invoke("sessions:load-history", sessionPath),
  deleteSession: (payload) => ipcRenderer.invoke("sessions:delete", payload),
  openDirectory: () => ipcRenderer.invoke("dialog:open-directory"),
  startSession: (payload) => ipcRenderer.invoke("agent:start-session", payload),
  prompt: (payload) => ipcRenderer.invoke("agent:prompt", payload),
  cancel: (payload) => ipcRenderer.invoke("agent:cancel", payload),
  respondPermission: (payload) =>
    ipcRenderer.invoke("agent:permission-response", payload),
  respondPlan: (payload) => ipcRenderer.invoke("agent:plan-response", payload),
  respondQuestions: (payload) =>
    ipcRenderer.invoke("agent:questions-response", payload),
  readPlan: (payload) => ipcRenderer.invoke("sessions:read-plan", payload),
  disposeAgent: (threadId) => ipcRenderer.invoke("agent:dispose", threadId),
  setAgentMode: (payload) => ipcRenderer.invoke("agent:set-mode", payload),
  listRewindPoints: (payload) =>
    ipcRenderer.invoke("agent:rewind-points", payload),
  executeRewind: (payload) => ipcRenderer.invoke("agent:rewind-execute", payload),
  forkSession: (payload) => ipcRenderer.invoke("agent:fork-session", payload),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  openPath: (p) => ipcRenderer.invoke("shell:open-path", p),
  readMedia: (filePath) => ipcRenderer.invoke("media:read", filePath),
  on: (channel, listener) => {
    const allowed = new Set([
      "agent:update",
      "agent:permission",
      "agent:plan-approval",
      "agent:user-questions",
      "agent:error",
      "agent:log",
      "agent:exit",
    ]);
    if (!allowed.has(channel)) {
      return () => undefined;
    }
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld("grokDesktop", api);

declare global {
  interface Window {
    grokDesktop?: DesktopApi;
  }
}
