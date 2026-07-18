import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAppStore,
  agentModeLabel,
  type AgentMode,
} from "./store";
import { TimelineEntryView, StreamItemView } from "./components/StreamItemView";
import { PermissionPrompt } from "./components/PermissionModal";
import { PlanApprovalModal } from "./components/PlanApprovalModal";
import { UserQuestionsModal } from "./components/UserQuestionsModal";
import { RewindModal, type RewindPointRow } from "./components/RewindModal";
import { ContextUsageMeter, SlashCommandPalette } from "./components/SlashCommandPalette";
import { detectTextDirection, shellDocumentAttrs } from "@shared/rtl";
import { buildTimeline, tailTimeline } from "@shared/stream-timeline";
import { questionsFromStreamItem } from "@shared/user-questions";
import type { PromptAttachment, SessionSummary, StreamItem } from "@shared/types";

function formatTokens(n: number): string {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function shouldSendComposerKey(
  key: string,
  shiftKey: boolean,
  isComposing = false,
): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}

const MAX_CLIPBOARD_ATTACHMENTS = 10;
const MAX_CLIPBOARD_BYTES = 20 * 1024 * 1024;

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function clipboardFilesToAttachments(
  files: File[],
): Promise<PromptAttachment[]> {
  const accepted = files.slice(0, MAX_CLIPBOARD_ATTACHMENTS);
  for (const file of accepted) {
    if (file.size > MAX_CLIPBOARD_BYTES) {
      throw new Error(`${file.name || "Clipboard file"} is larger than 20 MB`);
    }
  }
  return Promise.all(
    accepted.map(async (file, index) => ({
      id: `clip-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
      name: file.name || `clipboard-image-${index + 1}.png`,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    })),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const {
    ready,
    auth,
    direction,
    transparencyMode,
    agentMode,
    projects,
    sessionsByCwd,
    expandedProjects,
    hiddenProjects,
    activeProjectCwd,
    threads,
    activeThreadId,
    permission,
    planApproval,
    userQuestions,
    statusLine,
    bootstrap,
    selectProject,
    toggleProject,
    hideProject,
    openProjectDialog,
    cycleAgentMode,
    createThread,
    selectThread,
    deleteThread,
    deleteSession,
    resumeSession,
    sendPrompt,
    cancelPrompt,
    startAgent,
    setThreadModel,
    setThreadConfigOption,
    setThreadReasoningEffort,
    respondPermission,
    respondPlan,
    respondQuestions,
    skipQuestions,
    listRewindPoints,
    executeRewind,
    forkConversation,
  } = useAppStore();

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [slashPaletteOpen, setSlashPaletteOpen] = useState(false);
  const [inputDir, setInputDir] = useState<"ltr" | "rtl" | "auto">("auto");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPoints, setRewindPoints] = useState<RewindPointRow[]>([]);
  const [rewindLoading, setRewindLoading] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("grok.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelControlRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  /** Ignore scroll events caused by our own programmatic scrollToBottom. */
  const programmaticScroll = useRef(false);

  const openRewindPicker = async () => {
    setRewindOpen(true);
    setRewindLoading(true);
    try {
      const points = await listRewindPoints();
      setRewindPoints(points);
    } finally {
      setRewindLoading(false);
    }
  };

  // Tool chips + message actions (rewind / fork / reopen questions)
  useEffect(() => {
    (window as unknown as { __grokReopenQuestions?: (item: StreamItem) => void }).__grokReopenQuestions =
      (item: StreamItem) => {
        const qs = questionsFromStreamItem(item);
        if (!qs.length) return;
        const live = useAppStore.getState().userQuestions;
        useAppStore.getState().openUserQuestions({
          id:
            live?.id && !String(live.id).startsWith("pending-")
              ? live.id
              : `pending-${item.toolCallId || item.id}`,
          threadId: useAppStore.getState().activeThreadId || undefined,
          sessionId: live?.sessionId || "",
          questions: qs,
          source: live && !live.pending ? live.source : "tool_stream",
          toolCallId: item.toolCallId || live?.toolCallId,
          title: item.title,
          raw: item.raw ?? item.input,
          pending: !live || Boolean(live.pending),
        });
      };

    (window as unknown as { __grokRewindToItem?: (id: string) => void }).__grokRewindToItem =
      (itemId: string) => {
        const thread = useAppStore
          .getState()
          .threads.find((t) => t.id === useAppStore.getState().activeThreadId);
        if (!thread) return;
        let userIndex = 0;
        for (const it of thread.items) {
          if (it.kind !== "user") continue;
          if (it.id === itemId) {
            void (async () => {
              const ok = window.confirm(
                `Rewind to this message?\n\nThis message returns to the input. Everything after it is removed from chat history, and later file changes are restored (CLI /rewind).`,
              );
              if (!ok) return;
              const res = await useAppStore.getState().executeRewind(userIndex);
              if (res.ok && res.promptText != null) {
                setDraft(res.promptText);
                setInputDir(detectTextDirection(res.promptText));
                requestAnimationFrame(() => {
                  inputRef.current?.focus();
                  const el = inputRef.current;
                  if (el) {
                    el.selectionStart = el.selectionEnd = el.value.length;
                  }
                });
              }
            })();
            return;
          }
          userIndex += 1;
        }
      };

    (window as unknown as { __grokForkFromItem?: (id: string) => void }).__grokForkFromItem =
      (_itemId: string) => {
        void (async () => {
          const ok = window.confirm(
            "Fork this conversation into a new chat?\n\nHistory is copied; the original chat is left as-is (CLI /fork).",
          );
          if (!ok) return;
          await useAppStore.getState().forkConversation();
        })();
      };

    return () => {
      delete (window as unknown as { __grokReopenQuestions?: unknown })
        .__grokReopenQuestions;
      delete (window as unknown as { __grokRewindToItem?: unknown })
        .__grokRewindToItem;
      delete (window as unknown as { __grokForkFromItem?: unknown })
        .__grokForkFromItem;
    };
  }, []);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );

  const activeSessionSummary = useMemo(() => {
    if (!activeThread?.sessionId) return null;
    return (sessionsByCwd[activeThread.cwd] || []).find(
      (session) => session.id === activeThread.sessionId,
    ) ?? null;
  }, [activeThread?.cwd, activeThread?.sessionId, sessionsByCwd]);

  const navigableThreads = useMemo(() => {
    const cwd = activeThread?.cwd || activeProjectCwd;
    return cwd ? threads.filter((thread) => thread.cwd === cwd) : threads;
  }, [activeProjectCwd, activeThread?.cwd, threads]);
  const activeNavigationIndex = navigableThreads.findIndex(
    (thread) => thread.id === activeThreadId,
  );
  const previousThread =
    activeNavigationIndex > 0 ? navigableThreads[activeNavigationIndex - 1] : null;
  const nextThread =
    activeNavigationIndex >= 0 && activeNavigationIndex < navigableThreads.length - 1
      ? navigableThreads[activeNavigationIndex + 1]
      : null;

  const fullTimeline = useMemo(
    () => buildTimeline(activeThread?.items ?? []),
    [activeThread?.items],
  );

  const { visible: timeline, hiddenCount } = useMemo(() => {
    if (showAllHistory) return { visible: fullTimeline, hiddenCount: 0 };
    return tailTimeline(fullTimeline, 36);
  }, [fullTimeline, showAllHistory]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    setShowAllHistory(false);
    stickBottom.current = true;
  }, [activeThreadId]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 48), 200)}px`;
  }, [draft]);

  useEffect(() => {
    const attrs = shellDocumentAttrs(direction);
    document.documentElement.dir = attrs.dir;
    document.documentElement.lang = attrs.langHint;
  }, [direction]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "grok.sidebar.collapsed",
        sidebarCollapsed ? "1" : "0",
      );
    } catch {
      // Storage may be unavailable in hardened renderer contexts.
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const toggleSidebarShortcut = (event: KeyboardEvent) => {
      if (
        event.key === "\\" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener("keydown", toggleSidebarShortcut, true);
    return () => window.removeEventListener("keydown", toggleSidebarShortcut, true);
  }, []);

  // Content fingerprint so streaming agent_text (same timeline.length) still scrolls
  const streamContentTick = useMemo(() => {
    if (!activeThread) return 0;
    let n = activeThread.items.length;
    for (const it of activeThread.items) {
      n += (it.text?.length || 0) + (it.title?.length || 0);
      if (it.status) n += 1;
    }
    return n + (activeThread.isStreaming ? 1_000_000_000 : 0);
  }, [activeThread]);

  const scrollToBottomIfSticky = () => {
    const el = streamRef.current;
    if (!el || !stickBottom.current) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
    // release on next frame after scroll event
    requestAnimationFrame(() => {
      programmaticScroll.current = false;
    });
  };

  useEffect(() => {
    if (!streamRef.current) return;
    if (activeThread?.isLoadingHistory) return;
    if (!stickBottom.current) return;
    // Double rAF: wait for markdown/layout paint after React commit
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollToBottomIfSticky);
    });
  }, [
    activeThread?.isLoadingHistory,
    activeThreadId,
    timeline.length,
    activeThread?.isStreaming,
    streamContentTick,
  ]);

  // Global Shift+Tab — cycle Agent → Plan → Auto (Grok CLI parity)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Don't steal focus from native inputs when modifying selection with shift+tab in forms
        // except we intentionally want mode cycle like CLI — always cycle
        e.preventDefault();
        cycleAgentMode();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cycleAgentMode]);

  useEffect(() => {
    const interruptOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeThread?.isStreaming) return;
      // Escape dismisses transient UI first. It must never accidentally stop a
      // running agent while the user is only closing a menu or picker.
      if (
        conversationMenu ||
        settingsOpen ||
        rewindOpen ||
        permission ||
        planApproval ||
        userQuestions
        || slashPaletteOpen
      ) {
        return;
      }
      event.preventDefault();
      void cancelPrompt();
    };
    window.addEventListener("keydown", interruptOnEscape, true);
    return () => window.removeEventListener("keydown", interruptOnEscape, true);
  }, [
    activeThread?.isStreaming,
    cancelPrompt,
    conversationMenu,
    permission,
    planApproval,
    rewindOpen,
    settingsOpen,
    userQuestions,
    slashPaletteOpen,
  ]);

  const requestSlashCommands = async () => {
    if (commandsLoading) return;
    const threadId = activeThread?.id || createThread(activeProjectCwd || undefined);
    setCommandsLoading(true);
    try {
      await startAgent(threadId);
    } finally {
      setCommandsLoading(false);
    }
  };

  useEffect(() => {
    const closeConversationMenu = () => setConversationMenu(null);
    const closeConversationMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (conversationMenu || settingsOpen) event.preventDefault();
      closeConversationMenu();
      setSettingsOpen(false);
    };
    window.addEventListener("click", closeConversationMenu);
    window.addEventListener("keydown", closeConversationMenuOnEscape, true);
    return () => {
      window.removeEventListener("click", closeConversationMenu);
      window.removeEventListener("keydown", closeConversationMenuOnEscape, true);
    };
  }, [conversationMenu, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && modelControlRef.current?.contains(target)) return;
      setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [settingsOpen]);

  if (!ready) {
    return (
      <div className="app-shell" data-testid="app-loading">
        <div className="empty-state">
          <h3>Grok</h3>
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  const send = () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || activeThread?.isStreaming) return;
    if (!activeThread && activeProjectCwd) createThread(activeProjectCwd);
    else if (!activeThread) createThread();
    const promptText = text || "Please review the attached file(s).";
    void sendPrompt(promptText, attachments);
    setDraft("");
    setInputDir("auto");
    setAttachments([]);
    setAttachmentError(null);
    setSettingsOpen(false);
    inputRef.current?.focus();
  };

  const modeClass = agentMode === "agent" ? "" : agentMode;
  const effortOption = activeThread?.configOptions.find((option) =>
    /effort|reason/i.test(`${option.id} ${option.name}`),
  );
  const currentModel = activeThread?.models.find(
    (model) => model.id === activeThread.modelId,
  );
  const modelEffortChoices = currentModel?.supportsReasoningEffort
    ? currentModel.reasoningEfforts || []
    : [];
  const modelControlLabel = [
    currentModel?.name || activeThread?.modelId || "Model",
    currentModel?.supportsReasoningEffort
      ? effortOption?.currentValue || activeThread?.reasoningEffort
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const openModelSettings = async () => {
    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }
    // Open synchronously so the click always has immediate visual feedback.
    // Agent startup and settings discovery can take a moment on first use.
    setSettingsOpen(true);
    let threadId = activeThreadId;
    if (!threadId) threadId = createThread(activeProjectCwd || undefined);
    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    if (thread && !thread.sessionId) {
      setSettingsLoading(true);
      try {
        await startAgent(threadId);
      } catch {
        // The normal thread error path will surface agent startup failures.
      } finally {
        setSettingsLoading(false);
      }
    }
  };

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      dir={direction}
      data-testid="app-shell"
    >
      <header className="titlebar" data-testid="titlebar" dir="ltr">
        <div className="titlebar-sidebar">
          <button
            type="button"
            className="titlebar-icon sidebar-toggle"
            title={`${sidebarCollapsed ? "Show" : "Hide"} sidebar (⌘\\)`}
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-pressed={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <rect x="2.5" y="3" width="15" height="14" rx="2.5" />
              <path d="M7.25 3v14" />
            </svg>
          </button>
          <span className="titlebar-divider" aria-hidden />
          <button
            type="button"
            className="titlebar-icon"
            title="Previous chat"
            aria-label="Previous chat"
            disabled={!previousThread}
            onClick={() => previousThread && selectThread(previousThread.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-icon"
            title="Next chat"
            aria-label="Next chat"
            disabled={!nextThread}
            onClick={() => nextThread && selectThread(nextThread.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-icon titlebar-compose"
            title="New chat"
            aria-label="New chat"
            onClick={() => {
              createThread(activeThread?.cwd || activeProjectCwd || undefined);
              inputRef.current?.focus();
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden>
              <path d="M11.5 3H5.75A2.75 2.75 0 0 0 3 5.75v8.5A2.75 2.75 0 0 0 5.75 17h8.5A2.75 2.75 0 0 0 17 14.25V8.5" />
              <path d="m9 11 1.05-3.1L15.5 2.5l2 2-5.4 5.45L9 11Z" />
            </svg>
          </button>
        </div>
        <div className="titlebar-main">
          <div
            className="titlebar-conversation"
            title={activeThread?.cwd || activeProjectCwd || undefined}
          >
            <span className="titlebar-folder" aria-hidden>
              <svg viewBox="0 0 20 20">
                <path d="M2.5 5.25h5l1.6 1.75h8.4v8.25a1.75 1.75 0 0 1-1.75 1.75H4.25a1.75 1.75 0 0 1-1.75-1.75v-10Z" />
              </svg>
            </span>
            <div className="chat-heading">
              <strong>{activeThread?.title || "New chat"}</strong>
            </div>
            <div className="titlebar-menu-wrap">
              <button
                type="button"
                className="titlebar-icon titlebar-more"
                title="Conversation options"
                aria-label="Conversation options"
                aria-haspopup="menu"
                aria-expanded={conversationMenu === "titlebar"}
                onClick={(event) => {
                  event.stopPropagation();
                  setConversationMenu((current) =>
                    current === "titlebar" ? null : "titlebar",
                  );
                }}
              >
                <svg viewBox="0 0 20 20" aria-hidden>
                  <circle cx="4.5" cy="10" r="1" />
                  <circle cx="10" cy="10" r="1" />
                  <circle cx="15.5" cy="10" r="1" />
                </svg>
              </button>
              {conversationMenu === "titlebar" && (
                <div
                  className="titlebar-menu"
                  role="menu"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setConversationMenu(null);
                      createThread(activeThread?.cwd || activeProjectCwd || undefined);
                      inputRef.current?.focus();
                    }}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden>
                      <path d="M10 3v14M3 10h14" />
                    </svg>
                    <span>New chat</span>
                  </button>
                  {activeThread?.sessionId && !activeThread.isStreaming && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setConversationMenu(null);
                          void openRewindPicker();
                        }}
                      >
                        <svg viewBox="0 0 20 20" aria-hidden>
                          <path d="M4.5 7H2.75V2.75M3 6.5A7 7 0 1 1 4.6 15" />
                        </svg>
                        <span>Rewind conversation</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setConversationMenu(null);
                          if (window.confirm("Fork this conversation into a new chat? History is copied; original is kept.")) {
                            void forkConversation();
                          }
                        }}
                      >
                        <svg viewBox="0 0 20 20" aria-hidden>
                          <circle cx="5" cy="4" r="1.75" />
                          <circle cx="15" cy="5" r="1.75" />
                          <circle cx="10" cy="16" r="1.75" />
                          <path d="M5 5.75v2.5c0 2.2 1.8 4 4 4h1M15 6.75v1.5c0 2.2-1.8 4-4 4h-1V14" />
                        </svg>
                        <span>Fork conversation</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="titlebar-actions">
            <span className={`mode-badge ${modeClass}`} title="Shift+Tab to cycle modes">
              {agentModeLabel(agentMode)}
            </span>
            <span
              className={`badge ${auth?.loggedIn ? "ok" : "warn"}`}
              data-testid="auth-badge"
              title={auth?.message}
            >
              {auth?.loggedIn ? "Signed in" : "Sign in"}
            </span>
          </div>
        </div>
      </header>

      <div className="main-grid simple" data-testid="main-grid">
        <aside className="panel sidebar" data-testid="projects-sidebar" dir="ltr">
          <div className="panel-header">
            <div className="brand">
              <img
                className="brand-mark"
                src="./grok-mark.svg"
                width={20}
                height={20}
                alt=""
                aria-hidden
              />
              <span>Grok</span>
            </div>
            <button
              type="button"
              className="sidebar-open"
              onClick={() => void openProjectDialog()}
              title="Open folder"
              aria-label="Open project folder"
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M3.5 6.5h6l2 2h9v10h-17zM3.5 9h17" />
              </svg>
            </button>
          </div>

          <div className="sidebar-section-title">Projects</div>

          <div className="sidebar-scroll">
            {projects.filter((project) => !hiddenProjects[project.cwd]).length === 0 && (
              <div className="empty-state sm">
                <p>Open a project folder to start.</p>
                <button type="button" className="primary" onClick={() => void openProjectDialog()}>
                  Open project
                </button>
              </div>
            )}

            {projects.filter((project) => !hiddenProjects[project.cwd]).map((p) => {
              // Explicit expand state only — never force-open just because project is active
              const expanded = expandedProjects[p.cwd] === true;
              const sessionsLoaded = Object.prototype.hasOwnProperty.call(
                sessionsByCwd,
                p.cwd,
              );
              const sessions = sessionsByCwd[p.cwd] || [];
              const liveThreads = threads.filter((t) => t.cwd === p.cwd);
              const openSessionIds = new Set(
                liveThreads.map((t) => t.sessionId).filter(Boolean) as string[],
              );
              const diskOnly = sessions.filter((s) => !openSessionIds.has(s.id));
              // Collapsed projects never load sessions[] — use project.sessionCount from index
              const chatCount = sessionsLoaded
                ? Math.max(sessions.length, liveThreads.length)
                : Math.max(p.sessionCount || 0, liveThreads.length);
              // Prefer live aggregate from loaded sessions when available
              const tokens = sessionsLoaded
                ? sessions.reduce((n, s) => n + (s.tokensUsed || 0), 0) ||
                  p.totalTokens ||
                  0
                : p.totalTokens || 0;
              const duration = sessionsLoaded
                ? sessions.reduce((n, s) => n + (s.durationSeconds || 0), 0) ||
                  p.totalDurationSeconds ||
                  0
                : p.totalDurationSeconds || 0;

              return (
                <div key={p.id} className="project-group" data-testid="project-item">
                  <div
                    className={`project-row-wrap ${conversationMenu === `project-${p.id}` ? "menu-open" : ""}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setConversationMenu(`project-${p.id}`);
                    }}
                  >
                    <button
                      type="button"
                      className={`project-row ${activeProjectCwd === p.cwd ? "active" : ""} ${expanded ? "open" : ""}`}
                      aria-expanded={expanded}
                      onClick={() => {
                        setConversationMenu(null);
                        if (expanded) toggleProject(p.cwd);
                        else void selectProject(p.cwd, { expand: true });
                      }}
                    >
                      <span className="project-folder" aria-hidden>
                        <svg viewBox="0 0 24 24">
                          <path d="M3.5 6.5h6l2 2h9v10h-17z" />
                        </svg>
                      </span>
                      <span className="project-name">{p.label}</span>
                      <span className="count">{chatCount}</span>
                      <span className="caret" aria-hidden>
                        <svg viewBox="0 0 16 16">
                          <path d={expanded ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} />
                        </svg>
                      </span>
                    </button>
                    <div className="project-menu-wrap">
                      <button
                        type="button"
                        className="project-more"
                        title="Project options"
                        aria-label={`Project options for ${p.label}`}
                        aria-haspopup="menu"
                        aria-expanded={conversationMenu === `project-${p.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setConversationMenu((current) =>
                            current === `project-${p.id}` ? null : `project-${p.id}`,
                          );
                        }}
                      >
                        <span aria-hidden>•••</span>
                      </button>
                      {conversationMenu === `project-${p.id}` && (
                        <div
                          className="project-menu"
                          role="menu"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="project-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setConversationMenu(null);
                              createThread(p.cwd);
                              inputRef.current?.focus();
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden>
                              <path d="M12 5v14M5 12h14" />
                            </svg>
                            <span>New chat</span>
                          </button>
                          <button
                            type="button"
                            className="project-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setConversationMenu(null);
                              void window.grokDesktop?.openPath(p.cwd);
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden>
                              <path d="M3.5 6.5h6l2 2h9v10h-17zM8 12h8m-3-3 3 3-3 3" />
                            </svg>
                            <span>Open in Finder</span>
                          </button>
                          <button
                            type="button"
                            className="project-menu-item"
                            role="menuitem"
                            onClick={() => {
                              setConversationMenu(null);
                              void navigator.clipboard?.writeText(p.cwd);
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden>
                              <rect x="8" y="8" width="11" height="11" rx="2" />
                              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                            </svg>
                            <span>Copy project path</span>
                          </button>
                          <div className="project-menu-separator" role="separator" />
                          <button
                            type="button"
                            className="project-menu-item project-menu-hide"
                            role="menuitem"
                            onClick={() => {
                              setConversationMenu(null);
                              hideProject(p.cwd);
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden>
                              <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
                              <path d="m4 4 16 16" />
                            </svg>
                            <span>Hide project</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="chat-list">
                      {(tokens > 0 || duration > 0) && (
                        <div className="project-stats" title="Total across main chats in this project">
                          <span className="stat">
                            <span className="stat-label">Tokens</span>
                            <span className="stat-value">{formatTokens(tokens)}</span>
                          </span>
                          <span className="stat-sep" />
                          <span className="stat">
                            <span className="stat-label">Time</span>
                            <span className="stat-value">{formatTime(duration)}</span>
                          </span>
                          <span className="stat-sep" />
                          <span className="stat">
                            <span className="stat-label">Chats</span>
                            <span className="stat-value">{chatCount}</span>
                          </span>
                        </div>
                      )}

                      <button
                        type="button"
                        className="chat-row new"
                        onClick={() => {
                          createThread(p.cwd);
                          inputRef.current?.focus();
                        }}
                      >
                        + New chat
                      </button>

                      {liveThreads.map((t) => {
                        const menuKey = `thread-${t.id}`;
                        return (
                        <div
                          key={t.id}
                          className={`chat-row-wrap ${activeThreadId === t.id ? "active" : ""} ${conversationMenu === menuKey ? "menu-open" : ""}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setConversationMenu(menuKey);
                          }}
                        >
                          <button
                            type="button"
                            className={`chat-row ${activeThreadId === t.id ? "active" : ""}`}
                            data-testid="thread-item"
                            onClick={() => selectThread(t.id)}
                          >
                            <span className="chat-title">{t.title}</span>
                            {t.isStreaming && <span className="dot live" />}
                          </button>
                          <div className="chat-menu-wrap">
                            <button
                              type="button"
                              className="chat-more"
                              title="Conversation options"
                              aria-label={`Conversation options for ${t.title}`}
                              aria-haspopup="menu"
                              aria-expanded={conversationMenu === menuKey}
                              onClick={(event) => {
                                event.stopPropagation();
                                setConversationMenu((current) =>
                                  current === menuKey ? null : menuKey,
                                );
                              }}
                            >
                              <span aria-hidden>•••</span>
                            </button>
                            {conversationMenu === menuKey && (
                              <div
                                className="chat-menu"
                                role="menu"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="chat-menu-delete"
                                  role="menuitem"
                                  onClick={() => {
                                    setConversationMenu(null);
                                    if (
                                      confirm(
                                        t.sessionId
                                          ? "Delete this chat and all related subagent history?"
                                          : "Discard this empty chat?",
                                      )
                                    ) {
                                      void deleteThread(t.id);
                                    }
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden>
                                    <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />
                                  </svg>
                                  <span>Delete conversation</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        );
                      })}

                      {diskOnly.map((s: SessionSummary) => {
                        const menuKey = `session-${s.id}`;
                        return (
                        <div
                          key={s.id}
                          className={`chat-row-wrap ${conversationMenu === menuKey ? "menu-open" : ""}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setConversationMenu(menuKey);
                          }}
                        >
                          <button
                            type="button"
                            className="chat-row"
                            data-testid="session-item"
                            onClick={() => void resumeSession(s)}
                            title={s.id}
                          >
                            <span className="chat-title">{s.title}</span>
                            <span className="chat-meta">
                              {s.tokensUsed ? formatTokens(s.tokensUsed) + " · " : ""}
                              {s.updatedAt
                                ? new Date(s.updatedAt).toLocaleDateString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                  })
                                : ""}
                            </span>
                          </button>
                          <div className="chat-menu-wrap">
                            <button
                              type="button"
                              className="chat-more"
                              title="Conversation options"
                              aria-label={`Conversation options for ${s.title}`}
                              aria-haspopup="menu"
                              aria-expanded={conversationMenu === menuKey}
                              onClick={(event) => {
                                event.stopPropagation();
                                setConversationMenu((current) =>
                                  current === menuKey ? null : menuKey,
                                );
                              }}
                            >
                              <span aria-hidden>•••</span>
                            </button>
                            {conversationMenu === menuKey && (
                              <div
                                className="chat-menu"
                                role="menu"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className="chat-menu-delete"
                                  role="menuitem"
                                  onClick={() => {
                                    setConversationMenu(null);
                                    if (
                                      confirm(
                                        "Delete this conversation and all Grok subagent history for it? This cannot be undone.",
                                      )
                                    ) {
                                      void deleteSession(s);
                                    }
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" aria-hidden>
                                    <path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" />
                                  </svg>
                                  <span>Delete conversation</span>
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sr-only" data-testid="threads-sidebar" aria-hidden />
        </aside>

        <section className="chat-panel" data-testid="chat-panel">
          <div
            className="stream"
            ref={streamRef}
            data-testid="stream-view"
            onScroll={(e) => {
              if (programmaticScroll.current) return;
              const el = e.currentTarget;
              const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
              // Sticky only when user is near the bottom; scrolling up freezes follow
              stickBottom.current = dist < 96;
            }}
          >
            {!activeThread && (
              <div className="empty-state hero">
                <h3>What do you want to build?</h3>
                <p>Open a project and chat with Grok — same SuperGrok login as the CLI.</p>
                <button type="button" className="primary" onClick={() => void openProjectDialog()}>
                  Open project
                </button>
              </div>
            )}

            {activeThread?.isLoadingHistory && (
              <div className="loading-chat">
                <div className="loading-spinner" />
                <p>Loading conversation…</p>
              </div>
            )}

            {activeThread &&
              !activeThread.isLoadingHistory &&
              timeline.length === 0 &&
              !activeThread.error && (
                <div className="empty-state hero">
                  <h3>New chat</h3>
                  <p>Start with a question, task, or idea.</p>
                </div>
              )}

            {hiddenCount > 0 && !activeThread?.isLoadingHistory && (
              <button
                type="button"
                className="load-earlier"
                onClick={() => setShowAllHistory(true)}
              >
                Show {hiddenCount} earlier
              </button>
            )}

            {!activeThread?.isLoadingHistory && (
              <div className="stream-batch" key={activeThreadId || "none"}>
                {timeline.map((entry, idx) => {
                  // Live tail must NOT use content-visibility (breaks markdown paint
                  // until reopen). Only freeze far-above-fold history entries.
                  const fromEnd = timeline.length - 1 - idx;
                  const isSettledHistory =
                    !activeThread?.isStreaming && fromEnd > 12;
                  const entryKey =
                    entry.type === "item"
                      ? entry.item.id
                      : entry.id;
                  return (
                    <TimelineEntryView
                      key={entryKey}
                      entry={entry}
                      mode={transparencyMode}
                      audit={transparencyMode === "audit"}
                      isHistory={isSettledHistory}
                      isLive={Boolean(activeThread?.isStreaming) && idx === timeline.length - 1}
                    />
                  );
                })}
              </div>
            )}

            {activeThread?.error && (
              <StreamItemView
                item={{
                  id: "err",
                  kind: "error",
                  timestamp: Date.now(),
                  text: activeThread.error,
                }}
              />
            )}

            {activeThread?.isStreaming && (
              <div className="typing">
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
                Working…
              </div>
            )}
          </div>

          {/* Codex-style integrated composer */}
          <div className="composer" data-testid="composer">
            {permission && !planApproval && !userQuestions && (
              <PermissionPrompt
                permission={permission}
                onRespond={(allow, optionId) => void respondPermission(allow, optionId)}
              />
            )}
            <div className="composer-card">
              <SlashCommandPalette
                draft={draft}
                commands={activeThread?.availableCommands || []}
                loading={commandsLoading}
                session={activeSessionSummary}
                contextLimit={activeThread?.models.find((model) => model.id === activeThread.modelId)?.totalContextTokens}
                inputRef={inputRef}
                onOpenChange={setSlashPaletteOpen}
                onRequestCommands={() => void requestSlashCommands()}
                onSelect={(value) => {
                  setDraft(value);
                  setInputDir("ltr");
                }}
              />
              {attachments.length > 0 && (
                <div className="composer-attachments" aria-label="Attached clipboard files">
                  {attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className={`composer-attachment ${attachment.mimeType.startsWith("image/") ? "image" : "file"}`}
                    >
                      {attachment.mimeType.startsWith("image/") ? (
                        <img src={attachment.dataUrl} alt="" />
                      ) : (
                        <span className="attachment-file-icon" aria-hidden>⌑</span>
                      )}
                      <span className="attachment-meta">
                        <strong>{attachment.name}</strong>
                        <small>{formatBytes(attachment.size)}</small>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${attachment.name}`}
                        onClick={() =>
                          setAttachments((current) =>
                            current.filter((item) => item.id !== attachment.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentError && <div className="composer-attachment-error">{attachmentError}</div>}
              <textarea
                ref={inputRef}
                data-testid="prompt-input"
                className="composer-input"
                dir={inputDir}
                lang={inputDir === "rtl" ? "fa" : undefined}
                placeholder={
                  auth?.loggedIn
                    ? "Ask for follow-up changes"
                    : "Run grok login first (SuperGrok / X Premium+)"
                }
                value={draft}
                rows={1}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft(v);
                  setInputDir(detectTextDirection(v));
                }}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files || []);
                  if (!files.length) return;
                  e.preventDefault();
                  setAttachmentError(null);
                  void clipboardFilesToAttachments(files)
                    .then((incoming) => {
                      setAttachments((current) =>
                        [...current, ...incoming].slice(0, MAX_CLIPBOARD_ATTACHMENTS),
                      );
                    })
                    .catch((error: unknown) => {
                      setAttachmentError(
                        error instanceof Error ? error.message : String(error),
                      );
                    });
                }}
                onKeyDown={(e) => {
                  if (
                    shouldSendComposerKey(
                      e.key,
                      e.shiftKey,
                      e.nativeEvent.isComposing,
                    )
                  ) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bar">
                <div className="composer-bar-left">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Open project"
                    onClick={() => void openProjectDialog()}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className={`mode-pill ${modeClass}`}
                    title="Shift+Tab to cycle Agent → Plan → Auto"
                    onClick={() => cycleAgentMode()}
                  >
                    {agentModeLabel(agentMode)}
                  </button>
                  <span className="composer-hint">⇧Tab modes</span>
                </div>
                <div className="composer-bar-right">
                  <ContextUsageMeter
                    session={activeSessionSummary}
                    contextLimit={currentModel?.totalContextTokens}
                  />
                  <div className="model-control-wrap" ref={modelControlRef}>
                    {settingsOpen && (
                      <div className="model-popover" role="dialog" aria-label="Model settings">
                        <section>
                          <div className="model-popover-title">Model</div>
                          {(activeThread?.models.length || 0) === 0 ? (
                            <div className="model-empty">
                              {settingsLoading
                                ? "Loading model settings…"
                                : "No model choices reported by Grok"}
                            </div>
                          ) : (
                            activeThread?.models.map((model) => (
                              <button
                                type="button"
                                key={model.id}
                                className={model.id === activeThread.modelId ? "selected" : ""}
                                disabled={model.available === false}
                                title={
                                  model.available === false
                                    ? "Unavailable until Grok advertises this model for the active session"
                                    : model.description
                                }
                                onClick={() => {
                                  if (model.available === false) return;
                                  void setThreadModel(model.id);
                                  setSettingsOpen(false);
                                }}
                              >
                                <span>
                                  {model.name}
                                  {model.available === false && (
                                    <small>Unavailable in this Grok session</small>
                                  )}
                                </span>
                                {model.id === activeThread.modelId && <span>✓</span>}
                              </button>
                            ))
                          )}
                        </section>
                        {effortOption && effortOption.choices.length > 0 && (
                          <section>
                            <div className="model-popover-title">{effortOption.name}</div>
                            {effortOption.choices.map((choice) => (
                              <button
                                type="button"
                                key={choice.value}
                                className={
                                  choice.value === effortOption.currentValue ? "selected" : ""
                                }
                                onClick={() => {
                                  void setThreadConfigOption(effortOption.id, choice.value);
                                  setSettingsOpen(false);
                                }}
                              >
                                <span>
                                  {choice.name}
                                  {choice.description && <small>{choice.description}</small>}
                                </span>
                                {choice.value === effortOption.currentValue && <span>✓</span>}
                              </button>
                            ))}
                          </section>
                        )}
                        {!effortOption && modelEffortChoices.length > 0 && (
                          <section>
                            <div className="model-popover-title">Reasoning effort</div>
                            {modelEffortChoices.map((choice) => (
                              <button
                                type="button"
                                key={choice.value}
                                className={
                                  choice.value === activeThread?.reasoningEffort ? "selected" : ""
                                }
                                onClick={() => {
                                  void setThreadReasoningEffort(choice.value);
                                  setSettingsOpen(false);
                                }}
                              >
                                <span>
                                  {choice.name}
                                  {choice.description && <small>{choice.description}</small>}
                                </span>
                                {choice.value === activeThread?.reasoningEffort && <span>✓</span>}
                              </button>
                            ))}
                          </section>
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      className="model-control"
                      aria-expanded={settingsOpen}
                      onClick={() => void openModelSettings()}
                    >
                      <span>{modelControlLabel}</span>
                      <span className="model-chevron">⌄</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    className={`send-circle ${activeThread?.isStreaming ? "is-stop" : ""}`}
                    data-testid="send-button"
                    disabled={
                      !activeThread?.isStreaming &&
                      !draft.trim() &&
                      attachments.length === 0
                    }
                    title={activeThread?.isStreaming ? "Stop (Esc)" : "Send"}
                    onClick={() =>
                      activeThread?.isStreaming ? void cancelPrompt() : send()
                    }
                    aria-label={activeThread?.isStreaming ? "Stop" : "Send"}
                  >
                    {activeThread?.isStreaming ? <span className="stop-square" /> : "↑"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="status-bar" data-testid="status-bar">
        <span>{statusLine}</span>
        <span className="ltr-isolate" dir="ltr">
          {agentModeLabel(agentMode)} · {direction.toUpperCase()}
        </span>
      </footer>

      {planApproval && (
        <PlanApprovalModal
          plan={planApproval}
          onDecide={(decision, feedback) => void respondPlan(decision, feedback)}
        />
      )}

      {userQuestions && !planApproval && (
        <UserQuestionsModal
          request={userQuestions}
          onSubmit={(answers, notes) => void respondQuestions(answers, notes)}
          onSkip={() => void skipQuestions()}
        />
      )}

      {rewindOpen && (
        <RewindModal
          points={rewindPoints}
          loading={rewindLoading}
          onClose={() => setRewindOpen(false)}
          onPick={(idx) => {
            setRewindOpen(false);
            void (async () => {
              const res = await executeRewind(idx);
              if (res.ok && res.promptText != null) {
                setDraft(res.promptText);
                setInputDir(detectTextDirection(res.promptText));
                requestAnimationFrame(() => {
                  inputRef.current?.focus();
                  const el = inputRef.current;
                  if (el) {
                    el.selectionStart = el.selectionEnd = el.value.length;
                  }
                });
              }
            })();
          }}
        />
      )}
    </div>
  );
}
