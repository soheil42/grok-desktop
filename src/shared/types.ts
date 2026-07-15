/** Shared domain types for Grok Desktop (main + renderer). */

import type { PlanApprovalRequest } from "./plan-approval.js";
import type { UserQuestionRequest } from "./user-questions.js";

export type { PlanApprovalRequest } from "./plan-approval.js";
export type { UserQuestionRequest } from "./user-questions.js";

export type TextDirection = "ltr" | "rtl";

export type AuthStatus = {
  loggedIn: boolean;
  method: "cli-session" | "api-key" | "none";
  grokHome: string;
  authPath: string;
  hasAuthFile: boolean;
  message: string;
};

export type ProjectInfo = {
  id: string;
  cwd: string;
  label: string;
  encodedCwd: string;
  sessionCount: number;
  lastUpdated: string | null;
  /** Sum of tokens used across main sessions in this project */
  totalTokens?: number;
  /** Sum of sessionDurationSeconds from signals.json */
  totalDurationSeconds?: number;
  /** Earliest session created_at */
  firstActivityAt?: string | null;
  /** Latest last_active / updated_at */
  lastActivityAt?: string | null;
};

export type SessionSummary = {
  id: string;
  cwd: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  modelId: string | null;
  numMessages: number;
  parentSessionId: string | null;
  path: string;
  /** From signals.json when present */
  tokensUsed?: number;
  durationSeconds?: number;
};

export type StreamItemKind =
  | "user"
  | "agent_text"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "plan"
  | "permission"
  | "system"
  | "error";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export type DiffHunk = {
  path: string;
  oldText?: string;
  newText?: string;
  unified?: string;
};

export type MessageImage = {
  label: string;
  index?: number;
  /** Absolute filesystem path under ~/.grok/sessions */
  path?: string;
  /** data:image/... URL when already inlined */
  dataUrl?: string;
};

export type StreamItem = {
  id: string;
  kind: StreamItemKind;
  timestamp: number;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  title?: string;
  status?: ToolCallStatus;
  input?: unknown;
  output?: unknown;
  diffs?: DiffHunk[];
  raw?: unknown;
  /** Attached images for user messages — shown above the bubble */
  images?: MessageImage[];
};

export type PermissionRequest = {
  /** JSON-RPC request id from the agent — must preserve number vs string type. */
  id: string | number;
  /** Desktop thread that owns the GrokAcpClient binding for this request. */
  threadId?: string;
  sessionId: string;
  toolCallId?: string;
  title: string;
  description: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  raw: unknown;
};

/**
 * Preserve JSON-RPC id wire type. Numbers stay numbers; string ids stay strings.
 * Never coerce via String()/Number() for responses back to the agent.
 */
export function preserveJsonRpcId(id: unknown): string | number {
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string") return id;
  if (typeof id === "bigint") return Number(id);
  return String(id);
}

export type AcpSessionUpdate = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string } | string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string }>;
  entries?: unknown[];
  [key: string]: unknown;
};

export type ParsedUpdateBatch = {
  items: StreamItem[];
  permission?: PermissionRequest | null;
  /** Grok plan approval (exit_plan_mode / enter_plan_mode / x.ai/exit_plan_mode). */
  planApproval?: PlanApprovalRequest | null;
  /** Grok ask_user_question form. */
  userQuestions?: UserQuestionRequest | null;
};

export type ThreadState = {
  id: string;
  sessionId: string | null;
  cwd: string;
  title: string;
  items: StreamItem[];
  isStreaming: boolean;
  modelId: string | null;
  error: string | null;
};

