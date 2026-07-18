import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentCommandOption, SessionSummary } from "@shared/types";
import "./slash-command-palette.css";

type Props = {
  draft: string;
  commands: AgentCommandOption[];
  loading?: boolean;
  session?: SessionSummary | null;
  contextLimit?: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSelect: (value: string) => void;
  onRequestCommands?: () => void;
  onOpenChange?: (open: boolean) => void;
};

function CommandIcon({ name }: { name: string }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none" };
  if (/compact/i.test(name)) {
    return <svg {...common} aria-hidden><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (/context|session/i.test(name)) {
    return <svg {...common} aria-hidden><path d="M4 19V9m5 10V5m5 14v-7m5 7V3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
  }
  if (/approve|trust|permission/i.test(name)) {
    return <svg {...common} aria-hidden><path d="M12 3 5 6v5c0 4.8 2.9 8.1 7 10 4.1-1.9 7-5.2 7-10V6l-7-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>;
  }
  if (/goal|loop/i.test(name)) {
    return <svg {...common} aria-hidden><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" /><path d="m14 10 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
  }
  if (/plugin|hook|mcp/i.test(name)) {
    return <svg {...common} aria-hidden><path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-5 5v5M8 21h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg {...common} aria-hidden><path d="m8 8-4 4 4 4m4 1h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function commandQuery(draft: string): string | null {
  const match = draft.match(/^\/([^\s/]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function SlashCommandPalette({
  draft,
  commands,
  loading = false,
  session,
  contextLimit,
  inputRef,
  onSelect,
  onRequestCommands,
  onOpenChange,
}: Props) {
  const query = commandQuery(draft);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestedRef = useRef(false);
  const filtered = useMemo(() => {
    if (query == null) return [];
    return commands.filter((command) =>
      `${command.name} ${command.description}`.toLowerCase().includes(query),
    );
  }, [commands, query]);
  const open = query != null && dismissedDraft !== draft;

  useEffect(() => {
    if (query == null) {
      setDismissedDraft(null);
      requestedRef.current = false;
    }
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, filtered.length]);

  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || commands.length || requestedRef.current) return;
    requestedRef.current = true;
    onRequestCommands?.();
  }, [commands.length, onRequestCommands, open]);

  const choose = (command: AgentCommandOption) => {
    const next = `/${command.name}${command.inputHint ? " " : ""}`;
    setDismissedDraft(next);
    onSelect(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const input = inputRef.current;
      if (input) input.selectionStart = input.selectionEnd = input.value.length;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setDismissedDraft(draft);
        inputRef.current?.focus();
        return;
      }
      if (!filtered.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + delta + filtered.length) % filtered.length);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose(filtered[activeIndex] ?? filtered[0]);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (target === inputRef.current) return;
      setDismissedDraft(draft);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [activeIndex, draft, filtered, inputRef, open]);

  if (!open) return null;
  return (
    <div className="slash-palette" ref={panelRef} role="listbox" aria-label="Grok CLI commands">
      <div className="slash-palette-head">
        <span>Grok commands</span>
        {session && (session.contextWindowTokens || contextLimit)
          ? <ContextUsageInline session={session} contextLimit={contextLimit} />
          : <kbd>↑↓</kbd>}
      </div>
      <div className="slash-palette-list">
        {filtered.map((command, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "active" : ""}
            key={command.name}
            onPointerMove={() => setActiveIndex(index)}
            onClick={() => choose(command)}
          >
            <span className="slash-command-icon"><CommandIcon name={command.name} /></span>
            <span className="slash-command-name">/{command.name}</span>
            <span className="slash-command-description">{command.description}</span>
            {command.inputHint && <span className="slash-command-hint">{command.inputHint}</span>}
          </button>
        ))}
        {!filtered.length && (
          <div className="slash-palette-empty">
            {loading
              ? "Loading commands from Grok CLI…"
              : commands.length
                ? `No Grok command matches “/${query}”`
                : "Grok CLI did not report commands for this session"}
          </div>
        )}
      </div>
      <div className="slash-palette-foot"><span>Enter to insert</span><span>Esc to close</span></div>
    </div>
  );
}

function ContextUsageInline({ session, contextLimit }: { session: SessionSummary; contextLimit?: number }) {
  const used = session.tokensUsed || 0;
  const total = session.contextWindowTokens || contextLimit || 0;
  const percentage = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return <span className="slash-context-inline">{formatCompactTokens(used)} / {formatCompactTokens(total)} · {percentage}%</span>;
}

export function formatCompactTokens(value: number): string {
  if (value < 1000) return String(Math.max(0, value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function ContextUsageMeter({ session, contextLimit }: { session?: SessionSummary | null; contextLimit?: number }) {
  const used = session?.tokensUsed || 0;
  const total = session?.contextWindowTokens || contextLimit || 0;
  const known = Boolean(session && total > 0);
  const remaining = Math.max(0, total - used);
  const percentage = known ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div
      className={`context-usage ${known ? "known" : "unknown"}`}
      title={known
        ? `${formatCompactTokens(used)} tokens used · ${formatCompactTokens(remaining)} remain before context compaction · ${session?.compactionCount || 0} previous compactions`
        : "Context capacity has not been reported by Grok CLI yet"}
      aria-label={known ? `${percentage}% of context used` : "Context usage unavailable"}
    >
      <span className="context-usage-ring" style={{ "--usage": `${percentage * 3.6}deg` } as React.CSSProperties} />
      <span className="context-usage-copy">
        <strong>{known ? `${formatCompactTokens(remaining)} left` : "Context —"}</strong>
        {known && <small>{formatCompactTokens(used)} used</small>}
      </span>
    </div>
  );
}
