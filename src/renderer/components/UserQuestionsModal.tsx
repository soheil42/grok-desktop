import { useEffect, useMemo, useState } from "react";
import {
  OTHER_LABEL,
  type UserQuestion,
  type UserQuestionAnswers,
  type UserQuestionNotes,
  type UserQuestionRequest,
} from "@shared/user-questions";
import { detectTextDirection } from "@shared/rtl";

type Props = {
  request: UserQuestionRequest;
  onSubmit: (answers: UserQuestionAnswers, notes: UserQuestionNotes) => void;
  onSkip: () => void;
};

/**
 * Grok CLI-style question form:
 * - Pick one or more options
 * - Or choose Other and type a freeform answer
 * - Freeform-only questions get a text box
 */
export function UserQuestionsModal({ request, onSubmit, onSkip }: Props) {
  const questions = request.questions;
  const [answers, setAnswers] = useState<UserQuestionAnswers>({});
  const [notes, setNotes] = useState<UserQuestionNotes>({});

  // Reset when a new request arrives
  useEffect(() => {
    setAnswers({});
    setNotes({});
  }, [request.id]);

  const allAnswered = useMemo(() => {
    if (!questions.length) return false;
    return questions.every((q) => {
      const a = answers[q.id];
      const note = (notes[q.id] || "").trim();
      if (!q.options.length) return Boolean(note || (typeof a === "string" && a.trim()));
      if (Array.isArray(a)) {
        if (!a.length) return false;
        if (a.includes("__other__")) return Boolean(note);
        return true;
      }
      if (!a) return false;
      if (a === "__other__") return Boolean(note);
      return true;
    });
  }, [answers, notes, questions]);

  const toggle = (q: UserQuestion, optionId: string) => {
    setAnswers((prev) => {
      if (q.multiSelect) {
        const cur = Array.isArray(prev[q.id])
          ? [...(prev[q.id] as string[])]
          : prev[q.id]
            ? [String(prev[q.id])]
            : [];
        const idx = cur.indexOf(optionId);
        if (idx >= 0) cur.splice(idx, 1);
        else cur.push(optionId);
        return { ...prev, [q.id]: cur };
      }
      return { ...prev, [q.id]: optionId };
    });
  };

  const isSelected = (q: UserQuestion, optionId: string) => {
    const a = answers[q.id];
    if (Array.isArray(a)) return a.includes(optionId);
    return a === optionId;
  };

  const otherSelected = (q: UserQuestion) => isSelected(q, "__other__");

  return (
    <div
      className="modal-backdrop plan-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Questions from Grok"
      data-testid="user-questions-modal"
    >
      <div className="modal plan-modal questions-modal">
        <header className="plan-modal-header">
          <div className="plan-modal-badge questions-badge">Questions</div>
          <h2>
            {questions.length
              ? `${questions.length} question${questions.length === 1 ? "" : "s"} for you`
              : "Grok needs your input"}
          </h2>
          <p className="plan-modal-sub">
            Choose an option, or pick <strong>Other</strong> and type your own answer — then submit so the agent can continue.
          </p>
        </header>

        <div className="body plan-modal-body questions-body">
          {questions.length === 0 ? (
            <div className="plan-empty">
              <strong>No questions in payload</strong>
              <p>Waiting for Grok to send the question list…</p>
            </div>
          ) : (
            questions.map((q, qi) => {
              const qDir = detectTextDirection(
                [q.question, ...q.options.flatMap((option) => [option.label, option.description || ""])].join(" "),
              );
              return (
              <section
                key={q.id}
                className={`q-block ${qDir === "rtl" ? "is-rtl" : "is-ltr"}`}
                dir={qDir === "rtl" ? "rtl" : "ltr"}
                data-testid={`question-${qi}`}
              >
                <h3 className="q-title">
                  <span className="q-num">{qi + 1}</span>
                  {q.question}
                  {q.multiSelect && <span className="q-multi">multi-select</span>}
                </h3>

                {q.options.length === 0 ? (
                  <textarea
                    className="q-freeform"
                    rows={3}
                    placeholder="Type your answer here…"
                    data-testid={`question-${qi}-freeform`}
                    value={notes[q.id] ?? (typeof answers[q.id] === "string" ? String(answers[q.id]) : "")}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNotes((n) => ({ ...n, [q.id]: v }));
                      setAnswers((a) => ({ ...a, [q.id]: v }));
                    }}
                  />
                ) : (
                  <>
                    <div
                      className="q-options"
                      role={q.multiSelect ? "group" : "radiogroup"}
                      aria-label={q.question}
                    >
                      {q.options.map((opt) => {
                        const selected = isSelected(q, opt.id);
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={`q-option ${selected ? "selected" : ""}`}
                            aria-pressed={selected}
                            data-testid={`question-${qi}-opt-${opt.id}`}
                            onClick={() => toggle(q, opt.id)}
                          >
                            <span className={`q-check ${q.multiSelect ? "box" : "radio"}`}>
                              {selected ? "✓" : ""}
                            </span>
                            <span className="q-option-text">
                              <span className="q-label">{opt.label}</span>
                              {opt.description && (
                                <span className="q-desc">{opt.description}</span>
                              )}
                              {opt.preview && (
                                <pre className="q-preview code-font">{opt.preview}</pre>
                              )}
                            </span>
                          </button>
                        );
                      })}

                      {/* CLI "Other / Type your answer" */}
                      <button
                        type="button"
                        className={`q-option ${otherSelected(q) ? "selected" : ""}`}
                        aria-pressed={otherSelected(q)}
                        data-testid={`question-${qi}-opt-other`}
                        onClick={() => toggle(q, "__other__")}
                      >
                        <span className={`q-check ${q.multiSelect ? "box" : "radio"}`}>
                          {otherSelected(q) ? "✓" : ""}
                        </span>
                        <span className="q-option-text">
                          <span className="q-label">{OTHER_LABEL}</span>
                          <span className="q-desc">Type your own answer</span>
                        </span>
                      </button>
                    </div>

                    {otherSelected(q) && (
                      <textarea
                        className="q-freeform q-other-input"
                        rows={2}
                        placeholder="Type your answer here…"
                        data-testid={`question-${qi}-other-text`}
                        value={notes[q.id] ?? ""}
                        onChange={(e) =>
                          setNotes((n) => ({ ...n, [q.id]: e.target.value }))
                        }
                        autoFocus
                      />
                    )}
                  </>
                )}
              </section>
              );
            })
          )}
        </div>

        <footer className="plan-modal-footer">
          <div className="plan-shortcuts ltr-isolate" dir="ltr">
            <span>Answer every question to unblock Grok</span>
          </div>
          <div className="plan-actions">
            <button
              type="button"
              className="ghost"
              data-testid="questions-skip"
              onClick={onSkip}
            >
              Skip
            </button>
            <button
              type="button"
              className="primary"
              data-testid="questions-submit"
              disabled={questions.length > 0 && !allAnswered}
              onClick={() => onSubmit(answers, notes)}
            >
              Submit answers
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
