import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAppStore,
  agentModeLabel,
  type AgentMode,
} from "./store";
import { TimelineEntryView, StreamItemView } from "./components/StreamItemView";
import { PermissionModal } from "./components/PermissionModal";
import { PlanApprovalModal } from "./components/PlanApprovalModal";
import { UserQuestionsModal } from "./components/UserQuestionsModal";
import { RewindModal, type RewindPointRow } from "./components/RewindModal";
import { detectTextDirection, shellDocumentAttrs } from "@shared/rtl";
import { buildTimeline, tailTimeline } from "@shared/stream-timeline";
import { questionsFromStreamItem } from "@shared/user-questions";
import type { SessionSummary, StreamItem } from "@shared/types";

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
    openProjectDialog,
    cycleAgentMode,
    createThread,
    selectThread,
    deleteThread,
    deleteSession,
    resumeSession,
    sendPrompt,
    cancelPrompt,
    respondPermission,
    respondPlan,
    respondQuestions,
    skipQuestions,
    listRewindPoints,
    executeRewind,
    forkConversation,
  } = useAppStore();

  const [draft, setDraft] = useState("");
  const [inputDir, setInputDir] = useState<"ltr" | "rtl" | "auto">("auto");
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPoints, setRewindPoints] = useState<RewindPointRow[]>([]);
  const [rewindLoading, setRewindLoading] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickBottom = useRef(true);

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
                `Rewind to this message?\n\nConversation after it will be discarded and file changes from later turns restored (CLI /rewind).`,
              );
              if (!ok) return;
              await useAppStore.getState().executeRewind(userIndex);
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
    const attrs = shellDocumentAttrs(direction);
    document.documentElement.dir = attrs.dir;
    document.documentElement.lang = attrs.langHint;
  }, [direction]);

  useEffect(() => {
    if (!streamRef.current) return;
    if (activeThread?.isLoadingHistory) return;
    if (!stickBottom.current) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [
    activeThread?.isLoadingHistory,
    activeThreadId,
    timeline.length,
    activeThread?.isStreaming,
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
    if (!text || activeThread?.isStreaming) return;
    if (!activeThread && activeProjectCwd) createThread(activeProjectCwd);
    else if (!activeThread) createThread();
    void sendPrompt(text);
    setDraft("");
    inputRef.current?.focus();
  };

  const modeClass = agentMode === "agent" ? "" : agentMode;

  return (
    <div className="app-shell" dir={direction} data-testid="app-shell">
      <header className="titlebar" data-testid="titlebar">
        <div className="brand">
          <img
            className="brand-mark"
            src="./grok-mark.svg"
            width={18}
            height={18}
            alt=""
            aria-hidden
          />
          <span>Grok</span>
        </div>
        <div className="titlebar-actions">
          <span
            className={`mode-badge ${modeClass}`}
            title="Shift+Tab to cycle modes"
          >
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
      </header>

      <div className="main-grid simple" data-testid="main-grid">
        <aside className="panel sidebar" data-testid="projects-sidebar">
          <div className="panel-header">
            <h2>Chats</h2>
            <button
              type="button"
              className="primary sm"
              onClick={() => void openProjectDialog()}
              title="Open folder"
            >
              Open
            </button>
          </div>

          <div className="sidebar-scroll">
            {projects.length === 0 && (
              <div className="empty-state sm">
                <p>Open a project folder to start.</p>
                <button type="button" className="primary" onClick={() => void openProjectDialog()}>
                  Open project
                </button>
              </div>
            )}

            {projects.map((p) => {
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
                  <button
                    type="button"
                    className={`project-row ${activeProjectCwd === p.cwd ? "active" : ""} ${expanded ? "open" : ""}`}
                    aria-expanded={expanded}
                    onClick={() => {
                      if (expanded) {
                        // Collapse — do NOT call selectProject (it used to force re-open)
                        toggleProject(p.cwd);
                      } else {
                        // Expand + load sessions
                        void selectProject(p.cwd, { expand: true });
                      }
                    }}
                  >
                    <span className="caret">{expanded ? "▾" : "▸"}</span>
                    <span className="project-name">{p.label}</span>
                    <span className="count">{chatCount}</span>
                  </button>

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

                      {liveThreads.map((t) => (
                        <div
                          key={t.id}
                          className={`chat-row-wrap ${activeThreadId === t.id ? "active" : ""}`}
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
                          <button
                            type="button"
                            className="chat-del"
                            title="Delete chat"
                            aria-label="Delete chat"
                            onClick={(e) => {
                              e.stopPropagation();
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
                            ×
                          </button>
                        </div>
                      ))}

                      {diskOnly.map((s: SessionSummary) => (
                        <div key={s.id} className="chat-row-wrap">
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
                          <button
                            type="button"
                            className="chat-del"
                            title="Delete session + subagents"
                            aria-label="Delete session"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (
                                confirm(
                                  "Delete this conversation and all Grok subagent history for it? This cannot be undone.",
                                )
                              ) {
                                void deleteSession(s);
                              }
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="sr-only" data-testid="threads-sidebar" aria-hidden />
        </aside>

        <section className="chat-panel" data-testid="chat-panel">
          <div className="chat-toolbar">
            <div className="chat-heading">
              <strong>{activeThread?.title || "Grok Build"}</strong>
              {(activeThread?.cwd || activeProjectCwd) && (
                <div className="path ltr-isolate" dir="ltr">
                  {activeThread?.cwd || activeProjectCwd}
                </div>
              )}
            </div>
            <div className="toolbar-actions">
              {activeThread?.isStreaming && (
                <button type="button" className="danger sm" onClick={() => void cancelPrompt()}>
                  Stop
                </button>
              )}
              {activeThread?.sessionId && !activeThread.isStreaming && (
                <>
                  <button
                    type="button"
                    className="sm ghost"
                    title="Rewind to an earlier message (CLI /rewind)"
                    onClick={() => void openRewindPicker()}
                  >
                    Rewind
                  </button>
                  <button
                    type="button"
                    className="sm ghost"
                    title="Fork conversation into a new chat (CLI /fork)"
                    onClick={() => {
                      if (
                        window.confirm(
                          "Fork this conversation into a new chat? History is copied; original is kept.",
                        )
                      ) {
                        void forkConversation();
                      }
                    }}
                  >
                    Fork
                  </button>
                </>
              )}
              <button
                type="button"
                className="sm ghost"
                onClick={() => {
                  createThread(activeProjectCwd || undefined);
                  inputRef.current?.focus();
                }}
              >
                New chat
              </button>
            </div>
          </div>

          <div
            className="stream"
            ref={streamRef}
            data-testid="stream-view"
            onScroll={(e) => {
              const el = e.currentTarget;
              const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
              stickBottom.current = dist < 80;
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
                  <p>Describe a task. Shift+Tab cycles Agent · Plan · Auto.</p>
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
                {timeline.map((entry) => (
                  <TimelineEntryView
                    key={entry.type === "item" ? entry.item.id : entry.id}
                    entry={entry}
                    mode={transparencyMode}
                    audit={transparencyMode === "audit"}
                    isHistory
                  />
                ))}
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
            <div className="composer-card">
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
                rows={2}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft(v);
                  setInputDir(detectTextDirection(v));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
                  <span className="composer-hint">⇧Tab</span>
                </div>
                <div className="composer-bar-right">
                  {activeThread?.isStreaming ? (
                    <button type="button" className="danger sm" onClick={() => void cancelPrompt()}>
                      Stop
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="send-circle"
                    data-testid="send-button"
                    disabled={!draft.trim() || Boolean(activeThread?.isStreaming)}
                    title="Send (⌘/Ctrl+Enter)"
                    onClick={send}
                    aria-label="Send"
                  >
                    ↑
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

      {permission && !planApproval && !userQuestions && (
        <PermissionModal
          permission={permission}
          onRespond={(allow, optionId) => void respondPermission(allow, optionId)}
        />
      )}

      {rewindOpen && (
        <RewindModal
          points={rewindPoints}
          loading={rewindLoading}
          onClose={() => setRewindOpen(false)}
          onPick={(idx) => {
            setRewindOpen(false);
            void executeRewind(idx);
          }}
        />
      )}
    </div>
  );
}
