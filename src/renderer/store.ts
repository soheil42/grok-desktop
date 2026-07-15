import { create } from "zustand";
import { unstable_batchedUpdates } from "react-dom";
import { v4 as uuid } from "uuid";
import type {
  AuthStatus,
  PermissionRequest,
  ProjectInfo,
  SessionSummary,
  StreamItem,
  TextDirection,
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
  openProjectDialog: () => Promise<void>;
  cycleAgentMode: () => void;
  setAgentMode: (m: AgentMode) => void;
  createThread: (cwd?: string, title?: string) => string;
  selectThread: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  deleteSession: (session: SessionSummary) => Promise<void>;
  resumeSession: (session: SessionSummary) => Promise<void>;
  startAgent: (threadId: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
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
};

/** Queued answers when user submits before the live x.ai/ask_user_question RPC arrives. */
let queuedQuestionAnswers: {
  threadId: string;
  answers: UserQuestionAnswers;
  notes: UserQuestionNotes;
  questions: UserQuestionRequest["questions"];
} | null = null;

function api() {
  if (typeof window !== "undefined" && window.grokDesktop) {
    return window.grokDesktop;
  }
  return null;
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  auth: null,
  direction: "ltr",
  locale: navigator?.language ?? "en",
  transparencyMode: "clean",
  agentMode: "agent",
  projects: [],
  sessionsByCwd: {},
  expandedProjects: {},
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
        direction: resolveChromeDirection("auto", navigator?.language ?? "en"),
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
      direction: resolveChromeDirection("auto", navigator?.language ?? "en"),
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
        activeProjectCwd: dir,
        expandedProjects: { ...s.expandedProjects, [dir]: true },
      };
    });
    await get().selectProject(dir);
    get().createThread(dir);
  },

  cycleAgentMode: () => {
    set((s) => {
      const i = AGENT_MODE_ORDER.indexOf(s.agentMode);
      const next = AGENT_MODE_ORDER[(i + 1) % AGENT_MODE_ORDER.length];
      return {
        agentMode: next,
        statusLine:
          next === "plan"
            ? "Plan mode — design first, then approve"
            : next === "auto"
              ? "Auto mode — tools auto-approved"
              : "Agent mode — ask before risky tools",
      };
    });
  },
  setAgentMode: (m) => set({ agentMode: m }),

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
    const { sessionId } = await desktop.startSession({
      threadId,
      cwd: thread.cwd,
      sessionId: thread.sessionId || undefined,
      alwaysApprove: get().agentMode === "auto",
    });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, sessionId, error: null } : t,
      ),
      statusLine: "Ready",
    }));
  },

  sendPrompt: async (text) => {
    const desktop = api();
    let threadId = get().activeThreadId;
    if (!threadId) {
      threadId = get().createThread();
    }
    let thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

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
      });
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, isStreaming: false } : t,
        ),
        statusLine: "Ready",
      }));
      await get().refreshProjects();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, isStreaming: false, error: msg } : t,
        ),
        statusLine: msg,
      }));
    }
  },

  cancelPrompt: async () => {
    const desktop = api();
    const threadId = get().activeThreadId;
    if (!desktop || !threadId) return;
    await desktop.cancel({ threadId });
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, isStreaming: false } : t,
      ),
      statusLine: "Cancelled",
    }));
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
    if (get().agentMode === "auto" && desktop) {
      void desktop.respondPermission({
        threadId: p.threadId || get().activeThreadId || "",
        requestId: p.id,
        optionId: "allow-once",
        allow: true,
      });
      return;
    }
    get().setPermission(p);
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
}));

function processCwdFallback(): string {
  return "/";
}

export function resolvePermissionThreadId(
  permission: PermissionRequest | null,
  activeThreadId: string | null,
): string | null {
  if (!permission) return null;
  return permission.threadId || activeThreadId;
}
