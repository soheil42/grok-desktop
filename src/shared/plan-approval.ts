/**
 * Plan-mode approval helpers — mirrors Grok CLI plan mode:
 * - enter_plan_mode: permission to start planning
 * - exit_plan_mode / x.ai/exit_plan_mode: present plan.md for review
 *
 * @see ~/.grok/docs/user-guide/19-plan-mode.md
 */
import type { PermissionRequest } from "./types.js";

export type PlanApprovalKind = "exit_plan_mode" | "enter_plan_mode";

export type PlanApprovalDecision = "approved" | "rejected" | "abandoned";

export type PlanApprovalRequest = {
  /** JSON-RPC id — preserve number|string for agent pending map. */
  id: string | number;
  threadId?: string;
  sessionId: string;
  kind: PlanApprovalKind;
  title: string;
  /** Markdown body of the plan (may be empty). */
  planContent: string;
  planFilePath?: string;
  empty: boolean;
  /** How the agent asked: regular permission vs Grok ext_method. */
  source: "permission" | "ext_method";
  options?: PermissionRequest["options"];
  raw: unknown;
};

const EXIT_RE =
  /exit[_\s-]?plan[_\s-]?mode|exitplanmode|leave[_\s-]?plan|approve\s+plan|plan\s+ready/i;
const ENTER_RE = /enter[_\s-]?plan[_\s-]?mode|enterplanmode/i;

function haystackFromPermission(p: PermissionRequest): string {
  const raw = p.raw && typeof p.raw === "object" ? JSON.stringify(p.raw) : "";
  return `${p.title}\n${p.description}\n${p.toolCallId ?? ""}\n${raw}`;
}

/** Classify a permission request as plan enter/exit, or null. */
export function classifyPlanPermission(
  p: PermissionRequest,
): PlanApprovalKind | null {
  const hay = haystackFromPermission(p);
  if (EXIT_RE.test(hay)) return "exit_plan_mode";
  if (ENTER_RE.test(hay)) return "enter_plan_mode";
  // Tool kind / name fields
  const tool = (p.raw as { toolCall?: { title?: string; kind?: string } })
    ?.toolCall;
  const t = `${tool?.title ?? ""} ${tool?.kind ?? ""}`;
  if (EXIT_RE.test(t)) return "exit_plan_mode";
  if (ENTER_RE.test(t)) return "enter_plan_mode";
  return null;
}

export function extractPlanFields(raw: unknown): {
  content: string;
  path?: string;
} {
  if (!raw || typeof raw !== "object") return { content: "" };
  const o = raw as Record<string, unknown>;
  const toolCall = (o.toolCall ?? o.tool_call ?? {}) as Record<string, unknown>;
  const input = (toolCall.rawInput ??
    toolCall.input ??
    o.rawInput ??
    o.input ??
    {}) as Record<string, unknown>;

  const pathCandidates = [
    o.planFilePath,
    o.plan_file_path,
    o.planPath,
    o.plan_path,
    input.planFilePath,
    input.plan_file_path,
    toolCall.planFilePath,
  ];
  const contentCandidates = [
    o.planContent,
    o.plan_content,
    o.plan,
    o.content,
    input.planContent,
    input.plan_content,
    toolCall.planContent,
  ];

  let path: string | undefined;
  for (const c of pathCandidates) {
    if (typeof c === "string" && c.trim()) {
      path = c.trim();
      break;
    }
  }

  let content = "";
  for (const c of contentCandidates) {
    if (typeof c === "string" && c.trim()) {
      content = c;
      break;
    }
    if (Array.isArray(c)) {
      content = c
        .map((e, i) => {
          if (typeof e === "string") return `${i + 1}. ${e}`;
          if (e && typeof e === "object") {
            const r = e as Record<string, unknown>;
            return `${i + 1}. ${r.content ?? r.title ?? r.text ?? JSON.stringify(e)}`;
          }
          return `${i + 1}. ${String(e)}`;
        })
        .join("\n");
      if (content.trim()) break;
    }
  }

  return { content, path };
}

export function permissionToPlanApproval(
  p: PermissionRequest,
  kind: PlanApprovalKind,
): PlanApprovalRequest {
  const fields = extractPlanFields(p.raw);
  const content =
    fields.content ||
    (kind === "exit_plan_mode" && p.description && !EXIT_RE.test(p.description)
      ? p.description
      : "");
  const empty = !content.trim() || /^#?\s*No plan written yet/i.test(content);
  return {
    id: p.id,
    threadId: p.threadId,
    sessionId: p.sessionId,
    kind,
    title:
      kind === "exit_plan_mode"
        ? empty
          ? "No plan written yet"
          : "Plan ready for review"
        : "Enter plan mode?",
    planContent: content,
    planFilePath: fields.path,
    empty,
    source: "permission",
    options: p.options,
    raw: p.raw,
  };
}

/**
 * Format user feedback the way Grok CLI's plan approval view does
 * (`format_feedback` in the TUI — freeform notes ± line comments).
 */
export function formatPlanFeedback(feedback?: string): string | null {
  const fb = feedback?.trim();
  if (!fb) return null;
  return fb;
}

/**
 * Build the JSON-RPC result for x.ai/exit_plan_mode (Grok ext_method).
 *
 * CLI outcomes (from agent strings):
 * - approved  → execute exit_plan_mode; leave plan mode; start implementing
 * - rejected  → "user does not want to exit plan mode; continue planning"
 * - abandoned → abandon plan entirely; turn plan mode off
 */
export function buildExitPlanModeExtResult(
  decision: PlanApprovalDecision,
  feedback?: string,
): Record<string, unknown> {
  const fb = formatPlanFeedback(feedback);
  if (decision === "approved") {
    return {
      // Primary fields Grok exit_plan_mode client response expects
      outcome: "approved",
      decision: "approved",
      approved: true,
      abandoned: false,
      // Optional "approve w/ comments" notes — agent sees these while starting build
      feedback: fb,
      comments: fb,
      message: fb
        ? `Plan approved with comments:\n${fb}`
        : "Plan approved. Proceed with implementation.",
    };
  }
  if (decision === "abandoned") {
    return {
      outcome: "abandoned",
      decision: "abandoned",
      approved: false,
      abandoned: true,
      feedback: fb,
      comments: fb,
      message:
        "The user chose to abandon the plan entirely. Plan mode has been disabled. Do not call exit_plan_mode again unless the user explicitly asks to re-enter plan mode.",
    };
  }
  // rejected = request changes — stay in plan mode (CLI "s")
  return {
    outcome: "rejected",
    decision: "rejected",
    approved: false,
    abandoned: false,
    feedback:
      fb ??
      "Please revise the plan based on user feedback before calling exit_plan_mode again.",
    comments: fb,
    message:
      "The user does not want to exit plan mode. Continue planning and revise the plan." +
      (fb ? `\n\nUser feedback:\n${fb}` : ""),
  };
}

/**
 * Follow-up user message after a permission-path plan decision.
 * Permission responses only carry optionId; the model needs text for comments.
 */
export function planDecisionFollowUpPrompt(
  decision: PlanApprovalDecision,
  kind: PlanApprovalKind,
  feedback?: string,
): string | null {
  const fb = formatPlanFeedback(feedback);
  if (kind === "enter_plan_mode") {
    if (decision === "approved") return null;
    if (decision === "abandoned" || decision === "rejected") {
      return fb
        ? `I declined plan mode for now. ${fb}`
        : "I declined plan mode for now — continue without entering plan mode.";
    }
  }
  // exit_plan_mode
  if (decision === "approved") {
    return fb
      ? `Plan approved. Implement it, keeping these notes in mind:\n\n${fb}`
      : null; // tool result alone is enough when no comments
  }
  if (decision === "abandoned") {
    return (
      "I abandoned the plan entirely. Plan mode is off. Do not call exit_plan_mode again unless I ask to re-enter plan mode." +
      (fb ? `\n\n${fb}` : "")
    );
  }
  // request changes — stay planning
  return (
    "I do not want to exit plan mode yet. Continue planning and revise plan.md." +
    (fb ? `\n\nFeedback on the plan:\n${fb}` : "\n\nAsk me what to change if unclear.")
  );
}

/** Map plan decision onto standard ACP permission optionIds. */
export function planDecisionToOptionId(
  decision: PlanApprovalDecision,
  options?: PermissionRequest["options"],
): string {
  const opts = options ?? [];
  if (decision === "approved") {
    return (
      opts.find((o) => /allow|approve|accept/i.test(o.optionId + o.name + o.kind))
        ?.optionId ?? "allow-once"
    );
  }
  if (decision === "abandoned") {
    return (
      opts.find((o) => /abandon|cancel|quit|reject.*always|never/i.test(o.optionId + o.name))
        ?.optionId ??
      opts.find((o) => /reject|deny/i.test(o.optionId + o.name + o.kind))?.optionId ??
      "reject-once"
    );
  }
  return (
    opts.find((o) => /reject|deny|cancel/i.test(o.optionId + o.name + o.kind))
      ?.optionId ?? "reject-once"
  );
}

export function isExitPlanExtMethod(method: string): boolean {
  const m = method.replace(/^\/+/, "").toLowerCase();
  return (
    m === "x.ai/exit_plan_mode" ||
    m === "_x.ai/exit_plan_mode" ||
    m.endsWith("/exit_plan_mode") ||
    m === "exit_plan_mode"
  );
}

export function isAskUserQuestionExtMethod(method: string): boolean {
  const m = method.replace(/^\/+/, "").toLowerCase();
  return (
    m === "x.ai/ask_user_question" ||
    m === "_x.ai/ask_user_question" ||
    m.endsWith("/ask_user_question")
  );
}
