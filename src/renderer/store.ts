import { create } from "zustand";
import { unstable_batchedUpdates } from "react-dom";
import { v4 as uuid } from "uuid";
import type {
  AuthStatus,
  AgentConfigOption,
  AgentCommandOption,
  AgentModelOption,
  PermissionRequest,
  ProjectInfo,
  SessionSummary,
  StreamItem,
  TextDirection,
  PromptAttachment,
} from "@shared/types";
import {
  classifyPlanPermission,
  permissionToPlanApproval,
  planDecisionFollowUpPrompt,
  planDecisionToOptionId,
  type PlanApprovalDecision,
  type PlanApprovalRequest,
} from "@shared/plan-approval";
import {
  extractQuestions,
  isAskUserQuestionPermission,
  looksLikeAskUserQuestion,
  permissionToUserQuestions,
  questionsFromStreamItem,
  type UserQuestionAnswers,
  type UserQuestionNotes,
  type UserQuestionRequest,
} from "@shared/user-questions";
import { coalesceStreamItems } from "@shared/acp-parser";
import { filterVisibleStreamItems } from "@shared/stream-filter";
import { prepareHistoryItems } from "@shared/stream-timeline";
import { resolveChromeDirection } from "@shared/rtl";

export type Thread = {
  id: string;
  title: string;
  cwd: string;
  sessionId: string | null;
  sessionPath: string | null;
  items: StreamItem[];
  isStreaming: boolean;
  isLoadingHistory: boolean;
  error: string | null;
  modelId: string | null;
  models: AgentModelOption[];
  configOptions: AgentConfigOption[];
  availableCommands: AgentCommandOption[];
  reasoningEffort: string;
};

/** Matches Grok CLI Shift+Tab cycle: Agent → Plan → Auto */
export type AgentMode = "agent" | "plan" | "auto";

export const AGENT_MODE_ORDER: AgentMode[] = ["agent", "plan", "auto"];

export function agentModeLabel(mode: AgentMode): string {
  switch (mode) {
    case "plan":
      return "Plan";
    case "auto":
      return "Auto";
    default:
      return "Agent";
  }
}

type AppState = {
  ready: boolean;
  auth: AuthStatus | null;
  direction: TextDirection;
  locale: string;
  transparencyMode: "clean" | "transparent" | "audit";
  agentMode: AgentMode;
  projects: ProjectInfo[];
  sessionsByCwd: Record<string, SessionSummary[]>;
  expandedProjects: Record<string, boolean>;
  hiddenProjects: Record<string, boolean>;
  activeProjectCwd: string | null;
  threads: Thread[];
  activeThreadId: string | null;
  permission: PermissionRequest | null;
  planApproval: PlanApprovalRequest | null;
  userQuestions: UserQuestionRequest | null;
  statusLine: string;
  logs: string[];

  bootstrap: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  selectProject: (cwd: string, opts?: { expand?: boolean }) => Promise<void>;
  toggleProject: (cwd: string) => void;
  hideProject: (cwd: string) => void;
  openProjectDialog: () => Promise<void>;
  cycleAgentMode: () => void;
  setAgentMode: (m: AgentMode) => void;
  /** Push Agent/Plan/Auto onto the live ACP session (permission mode). */
  syncAgentModeToSession: (mode?: AgentMode) => Promise<void>;
  setThreadModel: (modelId: string) => Promise<void>;
  setThreadConfigOption: (optionId: string, value: string) => Promise<void>;
  setThreadReasoningEffort: (effort: string) => Promise<void>;
  createThread: (cwd?: string, title?: string) => string;
  selectThread: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  deleteSession: (session: SessionSummary) => Promise<void>;
  resumeSession: (session: SessionSummary) => Promise<void>;
  startAgent: (threadId: string) => Promise<void>;
  sendPrompt: (text: string, attachments?: PromptAttachment[]) => Promise<void>;
  cancelPrompt: () => Promise<void>;
  respondPermission: (allow: boolean, optionId?: string) => Promise<void>;
  respondPlan: (decision: PlanApprovalDecision, feedback?: string) => Promise<void>;
  respondQuestions: (
    answers: UserQuestionAnswers,
    notes?: UserQuestionNotes,
  ) => Promise<void>;
  skipQuestions: () => Promise<void>;
  /** Route permission → plan / questions modal when special tools fire. */
  routePermission: (p: PermissionRequest) => void;
  openPlanApproval: (p: PlanApprovalRequest) => Promise<void>;
  openUserQuestions: (p: UserQuestionRequest) => void;
  ingestAskUserFromStream: (threadId: string, items: StreamItem[]) => void;
  appendItems: (threadId: string, items: StreamItem[]) => void;
  setPermission: (p: PermissionRequest | null) => void;
  setPlanApproval: (p: PlanApprovalRequest | null) => void;
  setUserQuestions: (p: UserQuestionRequest | null) => void;
  /** List CLI rewind points for the active session. */
  listRewindPoints: () => Promise<
    Array<{
      prompt_index: number;
      created_at?: string;
      num_file_snapshots?: number;
      has_file_changes?: boolean;
      prompt_preview?: string;
    }>
  >;
  /**
   * CLI-parity rewind: restore files, truncate agent chat history to before
   * the selected user prompt, and return that prompt text for the composer.
   */
  executeRewind: (
    targetPromptIndex: number,
  ) => Promise<{ ok: boolean; promptText: string | null }>;
  /** Fork session into a new chat thread (CLI /fork parity). */
  forkConversation: (directive?: string) => Promise<string | null>;
};

/** Queued answers when user submits before the live x.ai/ask_user_question RPC arrives. */
let queuedQuestionAnswers: {
  threadId: string;
  answers: UserQuestionAnswers;
  notes: UserQuestionNotes;
  questions: UserQuestionRequest["questions"];
} | null = null;

const cancelledPromptThreads = new Set<string>();

function api() {
  if (typeof window !== "undefined" && window.grokDesktop) {
    return window.grokDesktop;
  }
  return null;
}

function detectLocale(): string {
  return typeof navigator !== "undefined" ? navigator.language ?? "en" : "en";
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  auth: null,
  direction: "ltr",
  locale: detectLocale(),
  transparencyMode: "clean",
  agentMode: "agent",
  projects: [],
  sessionsByCwd: {},
  expandedProjects: {},
  hiddenProjects: (() => {
    try {
      return JSON.parse(localStorage.getItem("grok-hidden-projects") || "{}");
    } catch {
      return {};
    }
  })(),
  activeProjectCwd: null,
  threads: [],
  activeThreadId: null,
  permission: null,
  planApproval: null,
  userQuestions: null,
  statusLine: "Starting…",
  logs: [],

  bootstrap: async () => {
    const desktop = api();
    if (!desktop) {
      set({
        ready: true,
        statusLine: "UI ready (open via Electron for Grok agent)",
        auth: {
          loggedIn: false,
          method: "none",
          grokHome: "~/.grok",
          authPath: "~/.grok/auth.json",
          hasAuthFile: false,
          message: "Running without Electron preload.",
        },
        direction: resolveChromeDirection("auto", detectLocale()),
      });
      return;
    }

    const boot = await desktop.getBootstrap();
    set({
      ready: true,
      auth: boot.auth as AuthStatus,
      statusLine: boot.auth.loggedIn
        ? "Ready · Grok CLI credentials"
        : boot.auth.message,
      direction: resolveChromeDirection("auto", detectLocale()),
    });

    desktop.on("agent:update", (payload) => {
      const p = payload as {
        threadId: string;
        items: StreamItem[];
        permission?: PermissionRequest | null;
        planApproval?: PlanApprovalRequest | null;
        userQuestions?: UserQuestionRequest | null;
      };
      if (p.items?.length) get().appendItems(p.threadId, p.items);

      // Priority: plan → live question request → permission → tool-stream questions
      if (p.planApproval) {
        void get().openPlanApproval({
          ...p.planApproval,
          threadId: p.planApproval.threadId || p.threadId,
        });
      }
      if (p.userQuestions) {
        get().openUserQuestions({
          ...p.userQuestions,
          threadId: p.userQuestions.threadId || p.threadId,
          pending: false,
        });
      } else if (p.permission) {
        get().routePermission({
          ...p.permission,
          threadId: p.permission.threadId || p.threadId,
        });
      }

      // Always scan stream tools for ask_user_question payloads (title "Ask 4 questions")
      if (p.items?.length) {
        get().ingestAskUserFromStream(p.threadId, p.items);
      }
    });
    desktop.on("agent:permission", (payload) => {
      const p = payload as { threadId: string; permission: PermissionRequest };
      get().routePermission({
        ...p.permission,
        threadId: p.permission.threadId || p.threadId,
      });
    });
    desktop.on("agent:plan-approval", (payload) => {
      const p = payload as { planApproval: PlanApprovalRequest; threadId?: string };
      void get().openPlanApproval({
        ...p.planApproval,
        threadId: p.planApproval.threadId || p.threadId,
      });
    });
    desktop.on("agent:user-questions", (payload) => {
      const p = payload as {
        userQuestions: UserQuestionRequest;
        threadId?: string;
      };
      get().openUserQuestions({
        ...p.userQuestions,
        threadId: p.userQuestions.threadId || p.threadId,
        pending: false,
      });
    });
    desktop.on("agent:error", (payload) => {
      const p = payload as { threadId: string; message: string };
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === p.threadId ? { ...t, error: p.message, isStreaming: false } : t,
        ),
        statusLine: p.message,
      }));
    });
    desktop.on("agent:log", (payload) => {
      const p = payload as { line: string };
      set((s) => ({ logs: [...s.logs.slice(-200), p.line] }));
    });
    desktop.on("agent:settings", (payload) => {
      const p = payload as { threadId: string; settings: import("@shared/types").AgentSessionSettings };
      set((s) => ({
        threads: s.threads.map((thread) =>
          thread.id === p.threadId
            ? {
                ...thread,
                modelId: p.settings.currentModelId || thread.modelId,
                models: p.settings.models || thread.models,
                configOptions: p.settings.configOptions || thread.configOptions,
                availableCommands: p.settings.availableCommands || thread.availableCommands,
                reasoningEffort: p.settings.reasoningEffort || thread.reasoningEffort,
              }
            : thread,
        ),
      }));
    });
    desktop.on("agent:exit", (payload) => {
      const p = payload as { threadId: string; code: number | null };
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === p.threadId ? { ...t, isStreaming: false } : t,
        ),
        statusLine: p.code ? `Agent exited (${p.code})` : "Ready",
      }));
    });

    await get().refreshProjects();
  },

  refreshAuth: async () => {
    const desktop = api();
    if (!desktop) return;
    const auth = (await desktop.getAuthStatus()) as AuthStatus;
    set({
      auth,
      statusLine: auth.loggedIn ? "Auth refreshed" : auth.message,
    });
  },

  refreshProjects: async () => {
    const desktop = api();
    if (!desktop) return;
    const projects = (await desktop.listProjects()) as ProjectInfo[];
    set({ projects });
    const cwd = get().activeProjectCwd;
    // Refresh session list for active project without forcing expand
    if (cwd) {
      await get().selectProject(cwd, {
        expand: get().expandedProjects[cwd] === true,
      });
    }
    // Don't auto-expand first project on load — user clicks to open
  },

  selectProject: async (cwd: string, opts?: { expand?: boolean }) => {
    const desktop = api();
    const expand = opts?.expand !== false;
    set((s) => ({
      activeProjectCwd: cwd,
      expandedProjects: expand
        ? { ...s.expandedProjects, [cwd]: true }
        : s.expandedProjects,
    }));
    if (!desktop) return;
    const sessions = (await desktop.listSessions(cwd)) as SessionSummary[];
    set((s) => ({
      sessionsByCwd: { ...s.sessionsByCwd, [cwd]: sessions },
    }));
  },

  toggleProject: (cwd: string) => {
    set((s) => {
      const currentlyOpen = s.expandedProjects[cwd] === true;
      return {
        expandedProjects: {
          ...s.expandedProjects,
          [cwd]: !currentlyOpen,
        },
        // Keep selection when collapsing so stats still make sense
        activeProjectCwd: s.activeProjectCwd || cwd,
      };
    });
  },

  hideProject: (cwd: string) => {
    set((s) => {
      const hiddenProjects = { ...s.hiddenProjects, [cwd]: true };
      try {
        localStorage.setItem("grok-hidden-projects", JSON.stringify(hiddenProjects));
      } catch {
        // Storage can be unavailable in hardened renderer contexts.
      }
      return {
        hiddenProjects,
        activeProjectCwd: s.activeProjectCwd === cwd ? null : s.activeProjectCwd,
      };
    });
  },

  openProjectDialog: async () => {
    const desktop = api();
    if (!desktop) return;
    const dir = await desktop.openDirectory();
    if (!dir) return;
    set((s) => {
      const exists = s.projects.some((p) => p.cwd === dir);
      const projects = exists
        ? s.projects
        : [
            {
              id: dir,
              cwd: dir,
              label: dir.split(/[\\/]/).filter(Boolean).pop() || dir,
              encodedCwd: encodeURIComponent(dir),
              sessionCount: 0,
              lastUpdated: null,
            },
            ...s.projects,
          ];
      return {
        projects,
        hiddenProjects: { ...s.hiddenProjects, [dir]: false },
        activeProjectCwd: dir,
        expandedProjects: { ...s.expandedProjects, [dir]: true },
      };
    });
    try {
      localStorage.setItem(
        "grok-hidden-projects",
        JSON.stringify(get().hiddenProjects),
      );
    } catch {
      // ignore
    }
    await get().selectProject(dir);
    get().createThread(dir);
  },

  cycleAgentMode: () => {
    const i = AGENT_MODE_ORDER.indexOf(get().agentMode);
    const next = AGENT_MODE_ORDER[(i + 1) % AGENT_MODE_ORDER.length];
    get().setAgentMode(next);
  },
  setAgentMode: (m) => {
    set({
      agentMode: m,
      statusLine:
        m === "plan"
          ? "Plan mode — design first, then approve"
          : m === "auto"
            ? "Auto mode — tools auto-approved"
            : "Agent mode — ask before tools",
    });
    void get().syncAgentModeToSession(m);
  },
  syncAgentModeToSession: async (mode) => {
    const desktop = api();
    const m = mode ?? get().agentMode;
    const threadId = get().activeThreadId;
    if (!desktop || !threadId) return;
    const thread = get().threads.find((t) => t.id === threadId);
    try {
      await desktop.setAgentMode({
        threadId,
        mode: m,
        sessionId: thread?.sessionId || undefined,
      });
    } catch {
      // Agent may not be started yet — startSession will apply mode
    }
  },

  createThread: (cwd, title) => {
    const projectCwd = cwd || get().activeProjectCwd || processCwdFallback();
    // Reuse an unused draft instead of spawning empties on rapid clicks
    const existing = get().threads.find(
      (t) =>
        t.cwd === projectCwd &&
        !t.sessionId &&
        t.items.length === 0 &&
        !t.isStreaming &&
        !t.isLoadingHistory &&
        (t.title === "New chat" || t.title === "New thread"),
    );
    if (existing) {
      set({
        activeThreadId: existing.id,
        activeProjectCwd: projectCwd,
        expandedProjects: { ...get().expandedProjects, [projectCwd]: true },
        statusLine: "Continue the empty chat",
      });
      return existing.id;
    }

    const id = uuid();
    const thread: Thread = {
      id,
      title: title || "New chat",
      cwd: projectCwd,
      sessionId: null,
      sessionPath: null,
      items: [],
      isStreaming: false,
      isLoadingHistory: false,
      error: null,
      modelId: null,
      models: [],
      configOptions: [],
      availableCommands: [],
      reasoningEffort: "high",
    };
    set((s) => ({
      threads: [thread, ...s.threads],
      activeThreadId: id,
      activeProjectCwd: projectCwd,
      expandedProjects: { ...s.expandedProjects, [projectCwd]: true },
    }));
    return id;
  },

  selectThread: (threadId) => set({ activeThreadId: threadId }),

  deleteThread: async (threadId) => {
    const desktop = api();
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

    // Dispose live agent if any
    if (desktop) {
      try {
        await desktop.disposeAgent(threadId);
      } catch {
        // ignore
      }
    }

    // If backed by on-disk session, wipe it + subagents
    if (desktop && (thread.sessionPath || thread.sessionId)) {
      try {
        await desktop.deleteSession({
          sessionId: thread.sessionId || undefined,
          sessionPath: thread.sessionPath || undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ statusLine: msg });
      }
    }

    set((s) => {
      const threads = s.threads.filter((t) => t.id !== threadId);
      const activeThreadId =
        s.activeThreadId === threadId
          ? threads.find((t) => t.cwd === thread.cwd)?.id || threads[0]?.id || null
          : s.activeThreadId;
      return { threads, activeThreadId, statusLine: "Chat deleted" };
    });
    await get().refreshProjects();
  },

  deleteSession: async (session) => {
    const desktop = api();
    if (!desktop) return;
    // Drop any live threads pointing at this session
    const linked = get().threads.filter((t) => t.sessionId === session.id);
    for (const t of linked) {
      try {
        await desktop.disposeAgent(t.id);
      } catch {
        // ignore
      }
    }
    try {
      await desktop.deleteSession({
        sessionId: session.id,
        sessionPath: session.path,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusLine: msg });
      return;
    }
    set((s) => {
      const threads = s.threads.filter((t) => t.sessionId !== session.id);
      const activeThreadId =
        s.activeThreadId && !threads.some((t) => t.id === s.activeThreadId)
          ? threads[0]?.id || null
          : s.activeThreadId;
      return { threads, activeThreadId, statusLine: "Session deleted" };
    });
    await get().refreshProjects();
  },

  resumeSession: async (session) => {
    const desktop = api();
    // Reuse open thread with same session id
    const existing = get().threads.find((t) => t.sessionId === session.id);
    if (existing && !existing.isLoadingHistory) {
      set({
        activeThreadId: existing.id,
        activeProjectCwd: session.cwd,
        expandedProjects: { ...get().expandedProjects, [session.cwd]: true },
      });
      return;
    }

    const threadId = uuid();
    // Paint shell immediately — don't stream history into the DOM line-by-line
    const placeholder: Thread = {
      id: threadId,
      title: session.title,
      cwd: session.cwd,
      sessionId: session.id,
      sessionPath: session.path,
      items: [],
      isStreaming: false,
      isLoadingHistory: true,
      error: null,
      modelId: session.modelId,
      models: [],
      configOptions: [],
      availableCommands: [],
      reasoningEffort: "high",
    };
    set((s) => ({
      threads: [placeholder, ...s.threads.filter((t) => t.sessionId !== session.id)],
      activeThreadId: threadId,
      activeProjectCwd: session.cwd,
      expandedProjects: { ...s.expandedProjects, [session.cwd]: true },
      statusLine: "Loading chat…",
    }));

    try {
      // Parallel: history (for UI) + agent attach. History is already prepared in main.
      const historyPromise =
        desktop && session.path
          ? (desktop.loadSessionHistory(session.path) as Promise<StreamItem[]>)
          : Promise.resolve([] as StreamItem[]);
      const attachPromise = desktop
        ? desktop.startSession({
            threadId,
            cwd: session.cwd,
            sessionId: session.id,
            alwaysApprove: get().agentMode === "auto",
          })
        : Promise.resolve({ sessionId: session.id });

      const [historyRaw, attach] = await Promise.all([
        historyPromise,
        attachPromise.catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          return { sessionId: session.id, attachError: msg };
        }),
      ]);

      // Defensive: re-cap on renderer in case of large payloads
      const history = prepareHistoryItems(historyRaw || [], 180);
      const attachErr =
        attach && "attachError" in attach
          ? String((attach as { attachError?: string }).attachError || "")
          : "";

      // One atomic UI update — no progressive item drip
      unstable_batchedUpdates(() => {
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === threadId
              ? {
                  ...t,
                  items: history,
                  isLoadingHistory: false,
                  sessionId:
                    (attach as { sessionId?: string })?.sessionId || t.sessionId,
                  modelId:
                    (attach as { settings?: { currentModelId?: string } })?.settings
                      ?.currentModelId || t.modelId,
                  models:
                    (attach as { settings?: { models?: AgentModelOption[] } })?.settings
                      ?.models || t.models,
                  configOptions:
                    (attach as { settings?: { configOptions?: AgentConfigOption[] } })
                      ?.settings?.configOptions || t.configOptions,
                  availableCommands:
                    (attach as { settings?: { availableCommands?: AgentCommandOption[] } })
                      ?.settings?.availableCommands || t.availableCommands,
                  reasoningEffort:
                    (attach as { settings?: { reasoningEffort?: string } })?.settings
                      ?.reasoningEffort || t.reasoningEffort,
                  error: attachErr || null,
                }
              : t,
          ),
          statusLine: attachErr || "Ready",
        }));
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? { ...t, isLoadingHistory: false, error: msg }
            : t,
        ),
        statusLine: msg,
      }));
    }
  },

  startAgent: async (threadId) => {
    const desktop = api();
    const thread = get().threads.find((t) => t.id === threadId);
    if (!desktop || !thread) return;
    const { sessionId, settings } = await desktop.startSession({
      threadId,
      cwd: thread.cwd,
      sessionId: thread.sessionId || undefined,
      alwaysApprove: get().agentMode === "auto",
    });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              sessionId,
              error: null,
              modelId: settings?.currentModelId || t.modelId,
              models: settings?.models || t.models,
              configOptions: settings?.configOptions || t.configOptions,
              availableCommands: settings?.availableCommands || t.availableCommands,
              reasoningEffort: settings?.reasoningEffort || t.reasoningEffort,
            }
          : t,
      ),
      statusLine: "Ready",
    }));
  },

  setThreadModel: async (modelId) => {
    const desktop = api();
    const threadId = get().activeThreadId;
    if (!desktop || !threadId) return;
    let thread = get().threads.find((item) => item.id === threadId);
    if (!thread) return;
    const previousModelId = thread.modelId;
    // Selecting a model is local-first; the ACP acknowledgement may take a
    // moment when Grok refreshes remote settings.
    set((state) => ({
      threads: state.threads.map((item) =>
        item.id === threadId ? { ...item, modelId, error: null } : item,
      ),
      statusLine: "Switching model…",
    }));
    if (!thread.sessionId) {
      await get().startAgent(threadId);
      thread = get().threads.find((item) => item.id === threadId);
    }
    try {
      const response = await desktop.setModel({
        threadId,
        sessionId: thread?.sessionId || undefined,
        modelId,
      });
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId
            ? {
                ...item,
                modelId: response.settings?.currentModelId || modelId,
                models: response.settings?.models || item.models,
                configOptions: response.settings?.configOptions || item.configOptions,
                reasoningEffort:
                  response.settings?.reasoningEffort || item.reasoningEffort,
                error: null,
              }
            : item,
        ),
        statusLine: "Ready",
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId
            ? { ...item, modelId: previousModelId, error: `Model switch failed: ${message}` }
            : item,
        ),
        statusLine: "Model switch failed",
      }));
    }
  },

  setThreadConfigOption: async (optionId, value) => {
    const desktop = api();
    const threadId = get().activeThreadId;
    if (!desktop || !threadId) return;
    let thread = get().threads.find((item) => item.id === threadId);
    if (!thread) return;
    if (!thread.sessionId) {
      await get().startAgent(threadId);
      thread = get().threads.find((item) => item.id === threadId);
    }
    const response = await desktop.setConfigOption({
      threadId,
      sessionId: thread?.sessionId || undefined,
      optionId,
      value,
    });
    set((state) => ({
      threads: state.threads.map((item) =>
        item.id === threadId
          ? {
              ...item,
              configOptions:
                response.settings?.configOptions ||
                item.configOptions.map((option) =>
                  option.id === optionId ? { ...option, currentValue: value } : option,
                ),
            }
          : item,
      ),
    }));
  },

  setThreadReasoningEffort: async (effort) => {
    const desktop = api();
    const threadId = get().activeThreadId;
    if (!desktop || !threadId) return;
    let thread = get().threads.find((item) => item.id === threadId);
    if (!thread) return;
    const selectedModelId = thread.modelId;
    const selectedModel = thread.models.find((model) => model.id === selectedModelId);
    const supportedEfforts = selectedModel?.reasoningEfforts?.map((choice) => choice.value) || [];
    if (!selectedModel?.supportsReasoningEffort || !supportedEfforts.includes(effort)) {
      set({ statusLine: `${selectedModel?.name || "This model"} does not support ${effort} effort` });
      return;
    }
    const previousEffort = thread.reasoningEffort;
    set((state) => ({
      threads: state.threads.map((item) =>
        item.id === threadId ? { ...item, reasoningEffort: effort, error: null } : item,
      ),
      statusLine: `Applying ${effort} effort…`,
    }));
    if (!thread.sessionId) {
      await get().startAgent(threadId);
      thread = get().threads.find((item) => item.id === threadId);
    }
    try {
      const response = await desktop.setReasoningEffort({
        threadId,
        sessionId: thread?.sessionId || undefined,
        effort,
        alwaysApprove: get().agentMode === "auto",
      });
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId
            ? {
                ...item,
                reasoningEffort: response.settings?.reasoningEffort || effort,
                modelId: response.settings?.currentModelId || item.modelId,
                models: response.settings?.models || item.models,
                configOptions: response.settings?.configOptions || item.configOptions,
                error: null,
              }
            : item,
        ),
        statusLine: `Reasoning effort · ${effort}`,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        threads: state.threads.map((item) =>
          item.id === threadId
            ? { ...item, reasoningEffort: previousEffort, error: `Effort change failed: ${message}` }
            : item,
        ),
        statusLine: "Effort change failed",
      }));
    }
  },

  sendPrompt: async (text, attachments = []) => {
    const desktop = api();
    let threadId = get().activeThreadId;
    if (!threadId) {
      threadId = get().createThread();
    }
    let thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    cancelledPromptThreads.delete(threadId);

    const mode = get().agentMode;
    // Plan mode: steer the agent like CLI plan mode without rewriting the agent.
    const outbound =
      mode === "plan"
        ? `[Plan mode — explore and write a plan only; do not edit code until the plan is approved.]\n\n${text}`
        : text;

    const userItem: StreamItem = {
      id: `user-${Date.now()}`,
      kind: "user",
      timestamp: Date.now(),
      text,
      images: attachments
        .filter((a) => a.mimeType.startsWith("image/"))
        .map((a, index) => ({ label: a.name, index: index + 1, dataUrl: a.dataUrl })),
      attachments: attachments
        .filter((a) => !a.mimeType.startsWith("image/"))
        .map((a) => ({ name: a.name, mimeType: a.mimeType, size: a.size })),
    };
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              items: [...t.items, userItem],
              isStreaming: true,
              error: null,
              title:
                t.title === "New chat" || t.title === "New thread"
                  ? text.slice(0, 48)
                  : t.title,
            }
          : t,
      ),
      statusLine: "Grok is working…",
    }));

    if (!desktop) {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                isStreaming: false,
                items: [
                  ...t.items,
                  {
                    id: `sys-${Date.now()}`,
                    kind: "error",
                    timestamp: Date.now(),
                    text: "Open the desktop app via Electron to talk to Grok.",
                  },
                ],
              }
            : t,
        ),
      }));
      return;
    }

    try {
      if (!thread.sessionId) {
        await get().startAgent(threadId);
        thread = get().threads.find((t) => t.id === threadId)!;
      }
      await desktop.prompt({
        threadId,
        text: outbound,
        sessionId: thread.sessionId || undefined,
        attachments,
      });
      if (cancelledPromptThreads.delete(threadId)) return;
      const completedCwd = thread.cwd;
      const completedSessionId = thread.sessionId;

      // Grok persists a canonical, fully-spaced final message to updates.jsonl.
      // Live ACP deltas can omit Markdown separators, so reconcile immediately
      // when the turn completes instead of making the user reopen the app.
      let canonicalItems: StreamItem[] | null = null;
      let canonicalPath: string | null = thread.sessionPath;
      try {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sessions = (await desktop.listSessions(completedCwd)) as SessionSummary[];
        set((s) => ({
          sessionsByCwd: { ...s.sessionsByCwd, [completedCwd]: sessions },
        }));
        const diskSession = sessions.find(
          (session) => session.id === completedSessionId,
        );
        if (diskSession?.path) {
          const raw = (await desktop.loadSessionHistory(
            diskSession.path,
          )) as StreamItem[];
          const prepared = prepareHistoryItems(raw || [], 180);
          if (prepared.some((item) => item.kind === "agent_text")) {
            canonicalItems = prepared;
            canonicalPath = diskSession.path;
          }
        }
      } catch {
        // Keep the live stream if disk reconciliation is briefly unavailable.
      }

      // Turn finished — use canonical history when available and settle tools.
      set((s) => ({
        threads: s.threads.map((t) => {
          if (t.id !== threadId) return t;
          const items = canonicalItems || t.items;
          return {
            ...t,
            isStreaming: false,
            error: null,
            sessionPath: canonicalPath || t.sessionPath,
            items: items.map((it) => {
              if (
                (it.kind === "tool_call" || it.kind === "tool_result") &&
                (it.status === "pending" || it.status === "in_progress" || !it.status)
              ) {
                return { ...it, status: "completed" as const, kind: "tool_result" as const };
              }
              return it;
            }),
          };
        }),
        statusLine: "Ready",
      }));
      await get().refreshProjects();
    } catch (e) {
      if (cancelledPromptThreads.delete(threadId)) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Timeout of the prompt RPC often means the turn is still streaming;
      // don't hard-fail the whole thread if we already have output.
      const isTimeout = /timeout/i.test(msg);
      set((s) => ({
        threads: s.threads.map((t) => {
          if (t.id !== threadId) return t;
          const hasContent = t.items.some(
            (it) => it.kind === "agent_text" || it.kind === "tool_result",
          );
          if (isTimeout && hasContent) {
            return {
              ...t,
              isStreaming: false,
              error: null,
              items: t.items.map((it) =>
                (it.kind === "tool_call" || it.kind === "tool_result") &&
                (it.status === "pending" || it.status === "in_progress" || !it.status)
                  ? { ...it, status: "completed" as const, kind: "tool_result" as const }
                  : it,
              ),
            };
          }
          return {
            ...t,
            isStreaming: false,
            error: msg,
            items: t.items.map((it) =>
              (it.kind === "tool_call" || it.kind === "tool_result") &&
              (it.status === "in_progress" || it.status === "pending")
                ? { ...it, status: "failed" as const }
                : it,
            ),
          };
        }),
        statusLine: isTimeout ? "Turn ended (timeout) — reply may still be complete" : msg,
      }));
    }
  },

  cancelPrompt: async () => {
    const desktop = api();
    const threadId = get().activeThreadId;
    if (!threadId) return;
    const thread = get().threads.find((t) => t.id === threadId);
    cancelledPromptThreads.add(threadId);
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              isStreaming: false,
              error: null,
              items: t.items.map((item) =>
                (item.kind === "tool_call" || item.kind === "tool_result") &&
                (item.status === "pending" || item.status === "in_progress")
                  ? { ...item, status: "cancelled" as const }
                  : item,
              ),
            }
          : t,
      ),
      statusLine: "Cancelled",
    }));
    if (!desktop) return;
    try {
      await desktop.cancel({
        threadId,
        sessionId: thread?.sessionId || undefined,
      });
    } catch {
      // UI is already cancelled; transport cancellation is best-effort.
    }
  },

  respondPermission: async (allow, optionId) => {
    const desktop = api();
    const perm = get().permission;
    const threadId = perm?.threadId || get().activeThreadId;
    if (!desktop || !perm || !threadId) return;
    await desktop.respondPermission({
      threadId,
      requestId: perm.id,
      optionId:
        optionId ||
        (allow ? perm.options.find((o) => o.kind.includes("allow"))?.optionId : undefined) ||
        (allow ? "allow-once" : "reject-once"),
      allow,
    });
    set({ permission: null });
  },

  routePermission: (p) => {
    const desktop = api();
    const planKind = classifyPlanPermission(p);
    if (planKind) {
      void get().openPlanApproval(permissionToPlanApproval(p, planKind));
      return;
    }
    if (isAskUserQuestionPermission(p)) {
      const uq = permissionToUserQuestions(p);
      // CLI auto-allows ask_user_question permission (wait_ms:0). The real form
      // is x.ai/ask_user_question. If questions are already on the permission,
      // show the form bound to this RPC id; otherwise allow and wait for ext.
      if (uq.questions.length > 0) {
        get().openUserQuestions({ ...uq, pending: false });
        return;
      }
      if (desktop) {
        void desktop.respondPermission({
          threadId: p.threadId || get().activeThreadId || "",
          requestId: p.id,
          optionId: "allow-once",
          allow: true,
        });
      }
      set({
        statusLine: "Waiting for questions…",
        permission: null,
      });
      return;
    }
    // Auto mode: approve non-plan/non-question tools without modal.
    // Main process also auto-allows when setAlwaysApprove is true; either path
    // is fine as long as Agent mode never auto-allows (that was the stuck-tools bug).
    if (get().agentMode === "auto" && desktop) {
      void desktop.respondPermission({
        threadId: p.threadId || get().activeThreadId || "",
        requestId: p.id,
        optionId: "allow-once",
        allow: true,
      });
      set({ statusLine: "Auto-approved tool", permission: null });
      return;
    }
    get().setPermission(p);
    set({
      statusLine: `Permission: ${p.title || "Allow tool?"}`,
    });
  },

  openUserQuestions: (p) => {
    let req: UserQuestionRequest = { ...p, pending: p.pending ?? String(p.id).startsWith("pending-") };
    if (!req.questions.length) {
      const qs = extractQuestions(req.raw);
      if (qs.length) req = { ...req, questions: qs };
    }

    // Upgrade a pending tool-stream modal with a live RPC id.
    const existing = get().userQuestions;
    if (
      existing &&
      existing.pending &&
      !req.pending &&
      existing.questions.length &&
      !req.questions.length
    ) {
      req = { ...req, questions: existing.questions };
    }
    if (
      existing &&
      existing.pending &&
      !req.pending &&
      req.questions.length === 0 &&
      existing.questions.length
    ) {
      req = { ...req, questions: existing.questions };
    }

    // Flush answers the user already submitted while we only had a pending id.
    if (
      !req.pending &&
      queuedQuestionAnswers &&
      queuedQuestionAnswers.threadId === (req.threadId || get().activeThreadId)
    ) {
      const q = queuedQuestionAnswers;
      queuedQuestionAnswers = null;
      set({
        userQuestions: {
          ...req,
          questions: req.questions.length ? req.questions : q.questions,
        },
        permission: null,
      });
      void get().respondQuestions(q.answers, q.notes);
      return;
    }

    if (!req.questions.length) {
      // Don't open empty modal — wait for tool_stream / ext payload
      return;
    }

    set({
      userQuestions: req,
      permission: null,
      statusLine: `Answer ${req.questions.length} question${req.questions.length === 1 ? "" : "s"}`,
    });
  },

  ingestAskUserFromStream: (threadId, items) => {
    for (const it of items) {
      if (it.kind !== "tool_call" && it.kind !== "tool_result") continue;
      if (
        !looksLikeAskUserQuestion(it.title, {
          input: it.input,
          raw: it.raw,
        })
      ) {
        continue;
      }
      const qs = questionsFromStreamItem(it);
      if (!qs.length) continue;

      const cur = get().userQuestions;
      // Already have a live (non-pending) form open — only refresh questions if empty
      if (cur && !cur.pending) {
        if (!cur.questions.length) {
          get().openUserQuestions({ ...cur, questions: qs });
        }
        continue;
      }
      // Open or refresh pending modal from stream (questions visible immediately)
      get().openUserQuestions({
        id: cur && !String(cur.id).startsWith("pending-") ? cur.id : `pending-${it.toolCallId || it.id}`,
        threadId,
        sessionId: cur?.sessionId || "",
        questions: qs,
        source: cur && !cur.pending ? cur.source : "tool_stream",
        toolCallId: it.toolCallId || cur?.toolCallId,
        title: it.title || "Questions",
        raw: it.raw ?? it.input,
        pending: !cur || cur.pending || String(cur.id).startsWith("pending-"),
      });
    }
  },

  respondQuestions: async (answers, notes = {}) => {
    const desktop = api();
    const req = get().userQuestions;
    const threadId = req?.threadId || get().activeThreadId;
    if (!desktop || !req || !threadId) return;

    // No live JSON-RPC yet — queue answers; flush when x.ai/ask_user_question arrives.
    if (req.pending || String(req.id).startsWith("pending-")) {
      queuedQuestionAnswers = {
        threadId,
        answers,
        notes,
        questions: req.questions,
      };
      set({
        // Keep modal closed but status shows waiting — RPC will flush queue
        userQuestions: { ...req, pending: true },
        statusLine: "Answers ready — waiting for agent handshake…",
      });
      // Keep modal open with questions so user sees state; hide only after RPC success
      set({
        userQuestions: null,
        statusLine: "Answers saved — complete when agent requests…",
      });
      return;
    }

    await desktop.respondQuestions({
      threadId,
      requestId: req.id,
      source: req.source === "tool_stream" ? "ext_method" : req.source,
      answers,
      notes,
      questions: req.questions,
    });
    queuedQuestionAnswers = null;
    set({
      userQuestions: null,
      statusLine: "Answers submitted — Grok continuing",
    });
  },

  skipQuestions: async () => {
    const desktop = api();
    const req = get().userQuestions;
    const threadId = req?.threadId || get().activeThreadId;
    if (!desktop || !req || !threadId) {
      set({ userQuestions: null });
      return;
    }
    if (req.pending || String(req.id).startsWith("pending-")) {
      queuedQuestionAnswers = null;
      set({ userQuestions: null, statusLine: "Skipped questions" });
      try {
        await desktop.prompt({
          threadId,
          text: "I skipped the questions — continue with your best judgment.",
        });
      } catch {
        // ignore
      }
      return;
    }
    await desktop.respondQuestions({
      threadId,
      requestId: req.id,
      source: req.source === "tool_stream" ? "ext_method" : req.source,
      answers: {},
      questions: req.questions,
      skip: true,
    });
    set({ userQuestions: null, statusLine: "Questions skipped" });
  },

  openPlanApproval: async (p) => {
    const desktop = api();
    let plan = { ...p };
    // Hydrate from plan.md when the agent sent an empty body (CLI does the same).
    if ((!plan.planContent || plan.empty) && desktop) {
      const thread = get().threads.find(
        (t) => t.id === (plan.threadId || get().activeThreadId),
      );
      try {
        const file = await desktop.readPlan({
          sessionId: plan.sessionId || thread?.sessionId || undefined,
          sessionPath: thread?.sessionPath || undefined,
          planFilePath: plan.planFilePath,
        });
        if (file?.content?.trim()) {
          plan = {
            ...plan,
            planContent: file.content,
            planFilePath: file.path || plan.planFilePath,
            empty: false,
            title:
              plan.kind === "exit_plan_mode"
                ? "Plan ready for review"
                : plan.title,
          };
        }
      } catch {
        // keep empty-state UI
      }
    }
    set({
      planApproval: plan,
      permission: null,
      statusLine:
        plan.kind === "enter_plan_mode"
          ? "Approve plan mode entry"
          : "Review plan before building",
    });
  },

  respondPlan: async (decision, feedback) => {
    const desktop = api();
    const plan = get().planApproval;
    const threadId = plan?.threadId || get().activeThreadId;
    if (!desktop || !plan || !threadId) return;

    const optionId = planDecisionToOptionId(decision, plan.options);

    // 1) Answer the pending agent request (permission or x.ai/exit_plan_mode).
    await desktop.respondPlan({
      threadId,
      requestId: plan.id,
      decision,
      feedback,
      source: plan.source,
      optionId,
    });

    // 2) Mirror CLI side-effects on desktop mode badge.
    //    approve/abandon exit → leave Plan badge (keep Auto if YOLO was on)
    //    request changes → stay Plan · approve enter → Plan
    const current = get().agentMode;
    let nextMode = current;
    if (plan.kind === "exit_plan_mode") {
      if (decision === "approved" || decision === "abandoned") {
        nextMode = current === "auto" ? "auto" : "agent";
      } else if (decision === "rejected") {
        nextMode = current === "auto" ? "auto" : "plan";
      }
    } else if (plan.kind === "enter_plan_mode") {
      nextMode = decision === "approved" ? "plan" : current === "plan" ? "agent" : current;
    }

    // 3) Follow-up prompt so the model gets comments / abandon / request-changes text.
    //    - ext_method already embeds feedback in the RPC result
    //    - permission path only has optionId, so we always prompt when needed
    //    - approve+comments and abandon always benefit from an explicit user message
    const followUp = planDecisionFollowUpPrompt(decision, plan.kind, feedback);
    const shouldPrompt =
      Boolean(followUp) &&
      (plan.source === "permission" ||
        decision === "rejected" ||
        decision === "abandoned" ||
        (decision === "approved" && Boolean(feedback?.trim())));

    set({
      planApproval: null,
      agentMode: nextMode,
      statusLine:
        decision === "approved"
          ? plan.kind === "enter_plan_mode"
            ? "Plan mode active — explore only until plan is approved"
            : feedback?.trim()
              ? "Plan approved w/ comments — building"
              : "Plan approved — building"
          : decision === "abandoned"
            ? "Plan abandoned — plan mode off"
            : "Changes requested — still in plan mode",
    });

    if (shouldPrompt && followUp) {
      try {
        // Small delay so the agent finishes handling the RPC response first.
        await new Promise((r) => setTimeout(r, 80));
        await desktop.prompt({ threadId, text: followUp });
      } catch {
        // Response already delivered; follow-up is best-effort.
      }
    }
  },

  appendItems: (threadId, items) => {
    const visible = filterVisibleStreamItems(items);
    if (!visible.length) return;
    set((s) => ({
      threads: s.threads.map((t) => {
        if (t.id !== threadId) return t;
        return {
          ...t,
          items: coalesceStreamItems([...t.items, ...visible]),
        };
      }),
    }));
  },

  setPermission: (p) => set({ permission: p }),
  setPlanApproval: (p) => set({ planApproval: p }),
  setUserQuestions: (p) => set({ userQuestions: p }),

  listRewindPoints: async () => {
    const desktop = api();
    const threadId = get().activeThreadId;
    const thread = get().threads.find((t) => t.id === threadId);
    if (!desktop || !threadId || !thread?.sessionId) return [];
    try {
      // Ensure agent is attached
      if (!thread.sessionId) return [];
      try {
        await desktop.startSession({
          threadId,
          cwd: thread.cwd,
          sessionId: thread.sessionId,
          alwaysApprove: get().agentMode === "auto",
        });
      } catch {
        // already running
      }
      const res = await desktop.listRewindPoints({
        threadId,
        sessionId: thread.sessionId,
      });
      return res.points || [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusLine: `Rewind list failed: ${msg}` });
      return [];
    }
  },

  executeRewind: async (targetPromptIndex) => {
    const desktop = api();
    const threadId = get().activeThreadId;
    const thread = get().threads.find((t) => t.id === threadId);
    if (!desktop || !threadId || !thread?.sessionId) {
      set({ statusLine: "No session to rewind" });
      return { ok: false, promptText: null };
    }
    try {
      // Capture the user text from UI before the agent truncates history.
      let localPromptText = "";
      let cutExclusive = thread.items.length; // drop target user msg + everything after
      {
        let userCount = 0;
        for (let i = 0; i < thread.items.length; i++) {
          if (thread.items[i].kind !== "user") continue;
          if (userCount === targetPromptIndex) {
            localPromptText = (thread.items[i].text || "").trim();
            // CLI: selected prompt leaves the transcript and returns to the composer
            cutExclusive = i;
            break;
          }
          userCount += 1;
        }
      }

      set({ statusLine: `Rewinding to prompt #${targetPromptIndex}…` });
      // Cancel any in-flight turn so rewind is not blocked
      try {
        await desktop.cancel({ threadId });
      } catch {
        // ignore
      }

      const result = await desktop.executeRewind({
        threadId,
        sessionId: thread.sessionId,
        targetPromptIndex,
        mode: "all",
      });
      if (result?.error || result?.success === false) {
        set({
          statusLine: result?.error || "Rewind failed",
        });
        return { ok: false, promptText: null };
      }

      // Agent returns the rewound prompt — put this in the composer (CLI parity).
      const promptText =
        (result?.prompt_text != null && String(result.prompt_text).trim()) ||
        localPromptText ||
        null;

      // Prefer reloading history from disk (agent truncated updates.jsonl / chat_history).
      // Fall back to local truncate: keep only messages *before* the selected user turn.
      // CLI: the selected user prompt is removed from history and returned as prompt_text.
      let history: StreamItem[] = thread.items.slice(0, cutExclusive);
      const sessionPath =
        thread.sessionPath ||
        (get().sessionsByCwd[thread.cwd] || []).find(
          (s) => s.id === thread.sessionId,
        )?.path ||
        null;

      if (sessionPath) {
        // Brief wait so disk flush completes after rewind execute
        await new Promise((r) => setTimeout(r, 120));
        try {
          const raw = (await desktop.loadSessionHistory(sessionPath)) as StreamItem[];
          history = prepareHistoryItems(raw || [], 180);
        } catch {
          // keep local truncate
        }
      }

      // Ensure UI never shows the rewound user turn or anything after it.
      // Disk may still be mid-flush; always re-cut by prompt index / text.
      history = truncateHistoryBeforeUserPrompt(
        history,
        targetPromptIndex,
        promptText,
      );

      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                items: history,
                sessionPath: sessionPath || t.sessionPath,
                isStreaming: false,
                error: null,
              }
            : t,
        ),
        permission: null,
        planApproval: null,
        userQuestions: null,
        statusLine: promptText
          ? `Rewound — edit and resend: ${promptText.slice(0, 48)}`
          : `Rewound to prompt #${targetPromptIndex}`,
      }));
      return { ok: true, promptText };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusLine: `Rewind failed: ${msg}` });
      return { ok: false, promptText: null };
    }
  },

  forkConversation: async (directive) => {
    const desktop = api();
    const threadId = get().activeThreadId;
    const thread = get().threads.find((t) => t.id === threadId);
    if (!desktop || !threadId || !thread?.sessionId) {
      set({ statusLine: "No session to fork" });
      return null;
    }
    try {
      set({ statusLine: "Forking conversation…" });
      try {
        await desktop.startSession({
          threadId,
          cwd: thread.cwd,
          sessionId: thread.sessionId,
          alwaysApprove: get().agentMode === "auto",
        });
      } catch {
        // live
      }
      const result = await desktop.forkSession({
        threadId,
        sessionId: thread.sessionId,
        cwd: thread.cwd,
        directive: directive || undefined,
      });
      const newId = result.newSessionId;
      if (!newId) {
        set({ statusLine: "Fork failed — no new session id" });
        return null;
      }

      // Open forked session as a new thread
      const forkedThreadId = uuid();
      const title = `Fork · ${thread.title}`.slice(0, 60);
      const placeholder: Thread = {
        id: forkedThreadId,
        title,
        cwd: thread.cwd,
        sessionId: newId,
        sessionPath: null,
        items: [],
        isStreaming: false,
        isLoadingHistory: true,
        error: null,
        modelId: thread.modelId,
        models: thread.models,
        configOptions: thread.configOptions,
        availableCommands: thread.availableCommands,
        reasoningEffort: thread.reasoningEffort,
      };
      set((s) => ({
        threads: [placeholder, ...s.threads],
        activeThreadId: forkedThreadId,
        statusLine: "Loading forked chat…",
      }));

      // Attach + load history for the child session
      try {
        const attach = await desktop.startSession({
          threadId: forkedThreadId,
          cwd: thread.cwd,
          sessionId: newId,
          alwaysApprove: get().agentMode === "auto",
        });
        // History path: reuse parent path group via session index refresh
        await get().refreshProjects();
        const sessions = get().sessionsByCwd[thread.cwd] || [];
        const child = sessions.find((s) => s.id === newId);
        let history: StreamItem[] = [];
        if (child?.path) {
          try {
            const raw = (await desktop.loadSessionHistory(
              child.path,
            )) as StreamItem[];
            history = prepareHistoryItems(raw || [], 180);
          } catch {
            // copy from parent items as fallback
            history = thread.items.slice();
          }
        } else {
          history = thread.items.slice();
        }
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === forkedThreadId
              ? {
                  ...t,
                  sessionId: attach.sessionId || newId,
                  sessionPath: child?.path || null,
                  items: history,
                  isLoadingHistory: false,
                  title: child?.title || title,
                }
              : t,
          ),
          statusLine: "Forked chat ready",
        }));
        if (directive?.trim()) {
          // Optional: kick off with directive as first prompt on the fork
          await get().sendPrompt(directive.trim());
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set((s) => ({
          threads: s.threads.map((t) =>
            t.id === forkedThreadId
              ? { ...t, isLoadingHistory: false, error: msg }
              : t,
          ),
          statusLine: msg,
        }));
      }
      return newId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ statusLine: `Fork failed: ${msg}` });
      return null;
    }
  },
}));

function processCwdFallback(): string {
  return "/";
}

/**
 * Drop the Nth user message and everything after it (CLI rewind UI parity).
 * The rewound prompt is moved into the composer, not kept in the stream.
 */
export function truncateHistoryBeforeUserPrompt(
  items: StreamItem[],
  targetPromptIndex: number,
  promptText?: string | null,
): StreamItem[] {
  const needle = (promptText || "").trim();
  let userCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "user") continue;
    if (userCount === targetPromptIndex) {
      return items.slice(0, i);
    }
    userCount += 1;
  }
  // Index past end or history already truncated — fall back to exact text cut
  if (needle) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "user" && (items[i].text || "").trim() === needle) {
        return items.slice(0, i);
      }
    }
  }
  return items;
}

export function resolvePermissionThreadId(
  permission: PermissionRequest | null,
  activeThreadId: string | null,
): string | null {
  if (!permission) return null;
  return permission.threadId || activeThreadId;
}
