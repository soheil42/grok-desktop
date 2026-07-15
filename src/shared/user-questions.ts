/**
 * ask_user_question — reverse-engineered from Grok CLI 0.2.x
 *
 * Wire flow:
 *  1. session/update tool_call title=ask_user_question rawInput.questions[]
 *  2. session/request_permission → auto-allow (CLI wait_ms:0)
 *  3. x.ai/ask_user_question JSON-RPC request → client shows form
 *  4. Client responds with internally-tagged AskUserQuestionExtResponse:
 *       { "Accepted": { "answers": { "<q>": ["label"] }, "partial_answers": null } }
 *       { "SkipInterview": null }
 *
 * answers values are ALWAYS string arrays:
 *  - single-select: one element
 *  - multi-select: many elements
 *  - freeform-only: ["Other"] + annotations[q].notes = typed text
 */
import type { PermissionRequest, StreamItem } from "./types.js";

export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
  preview?: string;
};

export type UserQuestion = {
  id: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

export type UserQuestionRequest = {
  id: string | number;
  threadId?: string;
  sessionId: string;
  questions: UserQuestion[];
  source: "permission" | "ext_method" | "tool_stream";
  toolCallId?: string;
  title?: string;
  raw: unknown;
  pending?: boolean;
};

/** question id → option id(s) and/or freeform text via special key */
export type UserQuestionAnswers = Record<string, string | string[]>;

/** Freeform annotation notes keyed by question id */
export type UserQuestionNotes = Record<string, string>;

const ASK_RE =
  /ask[_\s-]?user[_\s-]?question|askuserquestion|ask\s+\d+\s+questions?/i;

export const OTHER_LABEL = "Other";

export function isAskUserQuestionMethod(method: string): boolean {
  const m = method.replace(/^\/+/, "").toLowerCase();
  return (
    m === "x.ai/ask_user_question" ||
    m === "_x.ai/ask_user_question" ||
    m.endsWith("/ask_user_question") ||
    m === "ask_user_question"
  );
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseOption(o: unknown, i: number): QuestionOption | null {
  if (typeof o === "string" && o.trim()) {
    return { id: `opt-${i}`, label: o.trim() };
  }
  const r = asRec(o);
  if (!r) return null;
  const label = String(r.label ?? r.name ?? r.text ?? r.title ?? "").trim();
  if (!label) return null;
  return {
    id: String(r.id ?? r.optionId ?? r.option_id ?? `opt-${i}`),
    label,
    description:
      typeof r.description === "string" ? r.description : undefined,
    preview: typeof r.preview === "string" ? r.preview : undefined,
  };
}

function parseQuestion(q: unknown, i: number): UserQuestion | null {
  if (typeof q === "string" && q.trim()) {
    return {
      id: `q-${i}`,
      question: q.trim(),
      options: [],
      multiSelect: false,
    };
  }
  const r = asRec(q);
  if (!r) return null;
  const question = String(
    r.question ?? r.prompt ?? r.text ?? r.title ?? "",
  ).trim();
  if (!question) return null;
  const rawOpts = r.options ?? r.choices ?? r.answers;
  const options: QuestionOption[] = [];
  if (Array.isArray(rawOpts)) {
    rawOpts.forEach((o, j) => {
      const parsed = parseOption(o, j);
      if (parsed) options.push(parsed);
    });
  }
  const multi =
    r.multi_select === true ||
    r.multiSelect === true ||
    r.allow_multiple === true;
  return {
    id: String(r.id ?? r.questionId ?? r.question_id ?? `q-${i}`),
    question,
    options,
    multiSelect: multi,
  };
}

/** Pull questions from any known payload shape (tool rawInput, ext params, permission). */
export function extractQuestions(raw: unknown): UserQuestion[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((q, i) => parseQuestion(q, i))
      .filter((q): q is UserQuestion => Boolean(q));
  }

  const o = asRec(raw) || {};
  const toolCall = asRec(o.toolCall ?? o.tool_call) || {};
  const update = asRec(o.update) || {};
  const params = asRec(o.params) || {};
  const paramsTool = asRec(params.toolCall ?? params.tool_call) || {};

  const candidates: unknown[] = [
    o.questions,
    asRec(o.rawInput)?.questions,
    asRec(o.input)?.questions,
    toolCall.questions,
    asRec(toolCall.rawInput)?.questions,
    asRec(toolCall.input)?.questions,
    update.questions,
    asRec(update.rawInput)?.questions,
    params.questions,
    asRec(params.rawInput)?.questions,
    asRec(paramsTool.rawInput)?.questions,
  ];

  for (const list of candidates) {
    if (Array.isArray(list) && list.length) {
      const out: UserQuestion[] = [];
      list.forEach((q, i) => {
        const parsed = parseQuestion(q, i);
        if (parsed) out.push(parsed);
      });
      if (out.length) return out;
    }
  }

  for (const v of Object.values(o)) {
    const r = asRec(v);
    if (r && Array.isArray(r.questions) && r.questions.length) {
      return extractQuestions(r);
    }
  }
  return [];
}

export function looksLikeAskUserQuestion(
  title?: string,
  raw?: unknown,
): boolean {
  const hay = `${title ?? ""}\n${JSON.stringify(raw ?? {}).slice(0, 1500)}`;
  if (ASK_RE.test(hay)) return true;
  return extractQuestions(raw).length > 0;
}

export function isAskUserQuestionPermission(p: PermissionRequest): boolean {
  return looksLikeAskUserQuestion(`${p.title}\n${p.description}`, p.raw);
}

export function questionsFromStreamItem(item: StreamItem): UserQuestion[] {
  const fromInput = extractQuestions({
    rawInput: item.input,
    input: item.input,
  });
  if (fromInput.length) return fromInput;
  return extractQuestions(item.raw);
}

export function permissionToUserQuestions(
  p: PermissionRequest,
): UserQuestionRequest {
  return {
    id: p.id,
    threadId: p.threadId,
    sessionId: p.sessionId,
    questions: extractQuestions(p.raw),
    source: "permission",
    toolCallId: p.toolCallId,
    title: p.title,
    raw: p.raw,
    pending: false,
  };
}

/**
 * Build the ONLY shape Grok accepts for x.ai/ask_user_question.
 * Must be a pure internally-tagged enum — extra keys cause:
 *   "Client returned an invalid response to user question"
 */
export function buildAskUserQuestionResult(
  questions: UserQuestion[],
  answers: UserQuestionAnswers,
  notes?: UserQuestionNotes,
): Record<string, unknown> {
  /** question text → list of selected labels (CLI AnswerValues) */
  const answerMap: Record<string, string[]> = {};
  const annotations: Record<string, { notes?: string; preview?: string }> = {};

  questions.forEach((q) => {
    const raw = answers[q.id];
    const selected = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const labels: string[] = [];
    let freeformNote = notes?.[q.id]?.trim() || "";

    for (const idOrLabel of selected) {
      if (idOrLabel === "__other__" || idOrLabel === OTHER_LABEL) {
        if (!labels.includes(OTHER_LABEL)) labels.push(OTHER_LABEL);
        continue;
      }
      const opt = q.options.find(
        (o) => o.id === idOrLabel || o.label === idOrLabel,
      );
      labels.push(opt?.label ?? idOrLabel);
    }

    // Freeform-only question (no options): store as Other + notes
    if (!q.options.length) {
      const text =
        freeformNote ||
        (typeof raw === "string" ? raw.trim() : "") ||
        (Array.isArray(raw) ? raw.join(", ") : "");
      if (text) {
        answerMap[q.question] = [OTHER_LABEL];
        annotations[q.question] = { notes: text };
      }
      return;
    }

    // Selected Other with typed note
    if (labels.includes(OTHER_LABEL) && freeformNote) {
      annotations[q.question] = { notes: freeformNote };
    } else if (
      !labels.length &&
      freeformNote &&
      typeof raw === "string" &&
      !q.options.some((o) => o.id === raw || o.label === raw)
    ) {
      // Typed freeform stored as plain string answer
      answerMap[q.question] = [OTHER_LABEL];
      annotations[q.question] = { notes: freeformNote || raw };
      return;
    }

    if (labels.length) {
      answerMap[q.question] = labels;
    }
  });

  const body: Record<string, unknown> = {
    answers: answerMap,
    partial_answers: null,
  };
  if (Object.keys(annotations).length) {
    body.annotations = annotations;
  }

  // Pure enum — do NOT add sibling keys
  return { Accepted: body };
}

export function buildSkipInterviewResult(): Record<string, unknown> {
  // Pure enum variant
  return { SkipInterview: null };
}

export function askQuestionsAllowOptionId(
  options?: PermissionRequest["options"],
): string {
  return (
    options?.find((o) => /allow|approve|accept/i.test(o.optionId + o.name))
      ?.optionId ?? "allow-once"
  );
}

export function askQuestionsRejectOptionId(
  options?: PermissionRequest["options"],
): string {
  return (
    options?.find((o) => /reject|deny|cancel|skip/i.test(o.optionId + o.name))
      ?.optionId ?? "reject-once"
  );
}
