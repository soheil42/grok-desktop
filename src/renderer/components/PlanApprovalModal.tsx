import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PlanApprovalRequest } from "@shared/plan-approval";
import { proseRegionProps } from "@shared/rtl";

type Decision = "approved" | "rejected" | "abandoned";

type Props = {
  plan: PlanApprovalRequest;
  onDecide: (decision: Decision, feedback?: string) => void;
};

/**
 * Plan review modal — mirrors Grok CLI plan approval:
 *
 * | CLI | Desktop | Effect |
 * | a   | Approve | Exit plan mode, start implementing (optional notes = "approve w/ comments") |
 * | s   | Request changes | Stay in plan mode; agent revises plan.md |
 * | q   | Abandon | Drop plan, turn plan mode off |
 *
 * Line-range comments (CLI `c`) are approximated via the freeform notes field.
 */
export function PlanApprovalModal({ plan, onDecide }: Props) {
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"review" | "changes">("review");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isEnter = plan.kind === "enter_plan_mode";
  const prose = proseRegionProps(plan.planContent || "");
  const notesTrim = notes.trim();

  useEffect(() => {
    bodyRef.current?.focus();
  }, [plan.id]);

  useEffect(() => {
    if (mode === "changes") inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "TEXTAREA" || tag === "INPUT";
      if (e.key === "Escape") {
        if (mode === "changes") {
          setMode("review");
          e.preventDefault();
        }
        return;
      }
      if (inField && !(e.metaKey || e.ctrlKey)) return;
      if (e.key === "a" || e.key === "A") {
        if (inField && !e.metaKey && !e.ctrlKey) return;
        e.preventDefault();
        onDecide("approved", notesTrim || undefined);
      } else if ((e.key === "s" || e.key === "S") && !isEnter) {
        e.preventDefault();
        if (mode === "changes" && notesTrim) {
          onDecide("rejected", notesTrim);
        } else {
          setMode("changes");
        }
      } else if (e.key === "q" || e.key === "Q") {
        if (inField) return;
        e.preventDefault();
        onDecide("abandoned");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isEnter, mode, notesTrim, onDecide]);

  const emptyHint = isEnter
    ? "Approve to let the agent explore and write a plan before any code edits."
    : "Agent finished without writing plan.md. You can still approve to start building, request changes, or abandon.";

  return (
    <div
      className="modal-backdrop plan-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={plan.title}
      data-testid="plan-approval-modal"
    >
      <div className={`modal plan-modal ${isEnter ? "enter" : "exit"}`}>
        <header className="plan-modal-header">
          <div className="plan-modal-badge">{isEnter ? "Plan mode" : "Plan review"}</div>
          <h2>{plan.title}</h2>
          <p className="plan-modal-sub">
            {isEnter
              ? "If you approve, the agent plans only (edits blocked except plan.md) until you approve a plan."
              : "Approve starts implementation. Request changes keeps plan mode on. Abandon turns plan mode off."}
          </p>
        </header>

        <div
          className={`body plan-modal-body md ${prose.className}`}
          dir={prose.dir}
          lang={prose.lang}
          ref={bodyRef}
          tabIndex={0}
        >
          {plan.planContent.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {plan.planContent}
            </ReactMarkdown>
          ) : (
            <div className="plan-empty" data-testid="plan-empty">
              <strong>No plan written yet</strong>
              <p>{emptyHint}</p>
            </div>
          )}
        </div>

        {!isEnter && (
          <div className="plan-feedback">
            <label htmlFor="plan-feedback-input">
              {mode === "changes" ? "What should change in the plan?" : "Notes (optional)"}
            </label>
            <textarea
              id="plan-feedback-input"
              ref={inputRef}
              data-testid="plan-feedback-input"
              rows={mode === "changes" ? 3 : 2}
              placeholder={
                mode === "changes"
                  ? "e.g. Prefer REST over GraphQL; reuse existing auth middleware…"
                  : "Optional: comments sent with Approve, or switch to Request changes…"
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (mode === "changes") {
                    onDecide("rejected", notesTrim || undefined);
                  } else {
                    onDecide("approved", notesTrim || undefined);
                  }
                }
              }}
            />
            <p className="plan-feedback-hint">
              {mode === "changes" ? (
                <>
                  Sends feedback and <strong>stays in plan mode</strong> so the agent revises{" "}
                  <code>plan.md</code>. ⌘/Ctrl+Enter to send.
                </>
              ) : (
                <>
                  Notes on <strong>Approve</strong> = CLI “approve w/ comments”. Use{" "}
                  <strong>Request changes</strong> to revise without building.
                </>
              )}
            </p>
          </div>
        )}

        <footer className="plan-modal-footer">
          <div className="plan-shortcuts ltr-isolate" dir="ltr">
            <span>
              <kbd>a</kbd> approve
            </span>
            {!isEnter && (
              <span>
                <kbd>s</kbd> changes
              </span>
            )}
            <span>
              <kbd>q</kbd> {isEnter ? "deny" : "abandon"}
            </span>
          </div>
          <div className="plan-actions">
            <button
              type="button"
              className="ghost"
              data-testid="plan-abandon"
              title={
                isEnter
                  ? "Decline entering plan mode"
                  : "Abandon the plan and turn plan mode off"
              }
              onClick={() => onDecide("abandoned")}
            >
              {isEnter ? "Deny" : "Abandon"}
            </button>
            {!isEnter && (
              <button
                type="button"
                className="ghost"
                data-testid="plan-request-changes"
                title="Stay in plan mode and ask the agent to revise"
                onClick={() => {
                  if (mode === "changes") {
                    onDecide("rejected", notesTrim || undefined);
                  } else {
                    setMode("changes");
                    inputRef.current?.focus();
                  }
                }}
              >
                {mode === "changes" ? "Send changes" : "Request changes"}
              </button>
            )}
            {isEnter && (
              <button
                type="button"
                className="ghost"
                data-testid="plan-request-changes"
                onClick={() => onDecide("rejected")}
              >
                Not now
              </button>
            )}
            <button
              type="button"
              className="primary"
              data-testid="plan-approve"
              title={
                isEnter
                  ? "Enter plan mode — explore and write plan.md only"
                  : notesTrim
                    ? "Approve plan and pass your notes into the build"
                    : "Approve plan and start implementing"
              }
              onClick={() => onDecide("approved", notesTrim || undefined)}
            >
              {isEnter
                ? "Enter plan mode"
                : notesTrim
                  ? "Approve w/ comments"
                  : "Approve & build"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
