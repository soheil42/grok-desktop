import type {
  AcpSessionUpdate,
  DiffHunk,
  ParsedUpdateBatch,
  PermissionRequest,
  StreamItem,
  ToolCallStatus,
} from "./types.js";
import { preserveJsonRpcId } from "./types.js";
import {
  classifyPlanPermission,
  extractPlanFields,
  isExitPlanExtMethod,
  permissionToPlanApproval,
  type PlanApprovalRequest,
} from "./plan-approval.js";
import {
  extractQuestions,
  isAskUserQuestionMethod,
  isAskUserQuestionPermission,
  permissionToUserQuestions,
  type UserQuestionRequest,
} from "./user-questions.js";
import { joinAgentTextChunks } from "./markdown-normalize.js";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

/** Reset id counter — used by tests only. */
export function __resetParserIds(): void {
  idCounter = 0;
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join("\n");
  }
  if (typeof content === "object" && content !== null) {
    const row = content as Record<string, unknown>;
    if (typeof row.text === "string") return row.text;
    for (const key of [
      "output_for_prompt",
      "tool_output_for_prompt_concise",
      "tool_output_for_prompt",
      "content_concise",
      "stdout",
      "stderr",
      "content",
    ]) {
      const text = extractText(row[key]);
      if (text) return text;
    }
  }
  return "";
}

function mapStatus(status: string | undefined): ToolCallStatus | undefined {
  if (status == null || status === "") return undefined;
  switch (String(status).toLowerCase()) {
    case "pending":
      return "pending";
    case "in_progress":
    case "running":
      return "in_progress";
    case "completed":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      // Unknown ACP status — do not invent "in_progress" (that blinks forever)
      return undefined;
  }
}

/** Prefer a terminal status over a transient one when merging tool updates. */
export function preferToolStatus(
  prev?: ToolCallStatus | null,
  next?: ToolCallStatus | null,
): ToolCallStatus | undefined {
  const rank = (s?: ToolCallStatus | null) => {
    switch (s) {
      case "failed":
      case "cancelled":
        return 4;
      case "completed":
        return 3;
      case "in_progress":
        return 2;
      case "pending":
        return 1;
      default:
        return 0;
    }
  };
  return rank(next) >= rank(prev) ? next || prev || undefined : prev || next || undefined;
}

function extractDiffs(update: AcpSessionUpdate): DiffHunk[] | undefined {
  const diffs: DiffHunk[] = [];
  const raw = update as Record<string, unknown>;

  // Common shapes: content array with type diff, or rawOutput with diff text
  const contentArr = Array.isArray(raw.content) ? (raw.content as unknown[]) : [];
  for (const block of contentArr) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "diff" || b.type === "file_diff") {
      diffs.push({
        path: String(b.path ?? b.file ?? "file"),
        oldText: b.oldText != null ? String(b.oldText) : undefined,
        newText: b.newText != null ? String(b.newText) : undefined,
        unified: b.diff != null ? String(b.diff) : b.unified != null ? String(b.unified) : undefined,
      });
    }
  }

  if (raw.locations && Array.isArray(raw.locations)) {
    for (const loc of raw.locations as Array<{ path?: string }>) {
      if (loc?.path && !diffs.some((d) => d.path === loc.path)) {
        diffs.push({ path: loc.path });
      }
    }
  }

  // Tool output that looks like a unified diff
  const out =
    typeof raw.rawOutput === "string"
      ? raw.rawOutput
      : typeof raw.output === "string"
        ? raw.output
        : "";
  if (out.includes("@@") && (out.includes("---") || out.includes("diff "))) {
    const pathMatch = out.match(/(?:---|\+\+\+)\s+[ab]\/(.+)/);
    diffs.push({
      path: pathMatch?.[1]?.trim() ?? "diff",
      unified: out,
    });
  }

  return diffs.length ? diffs : undefined;
}

/**
 * Parse a single ACP session/update payload into UI stream items.
 * Handles both standard ACP shapes and Grok `_x.ai/session/update` wrappers.
 */
export function parseSessionUpdate(
  update: AcpSessionUpdate | null | undefined,
  opts?: { sessionId?: string },
): ParsedUpdateBatch {
  if (!update || typeof update !== "object") {
    return { items: [] };
  }

  // Unwrap Grok-style { update: { sessionUpdate: ... } }
  let body: AcpSessionUpdate = update;
  if (
    "update" in update &&
    update.update &&
    typeof update.update === "object" &&
    !update.sessionUpdate
  ) {
    body = update.update as AcpSessionUpdate;
  }

  const sessionUpdate = String(body.sessionUpdate ?? body.type ?? "");
  const items: StreamItem[] = [];
  let permission: PermissionRequest | null = null;
  const ts = Date.now();

  switch (sessionUpdate) {
    case "agent_message_chunk":
    case "agent_message":
    case "message": {
      const text = extractText(body.content);
      if (text) {
        items.push({
          id: nextId("msg"),
          kind: "agent_text",
          timestamp: ts,
          text,
          raw: body,
        });
      }
      break;
    }
    case "agent_thought_chunk":
    case "agent_thought":
    case "thought": {
      const text = extractText(body.content);
      if (text) {
        items.push({
          id: nextId("thought"),
          kind: "thought",
          timestamp: ts,
          text,
          raw: body,
        });
      }
      break;
    }
    case "user_message_chunk":
    case "user_message": {
      const text = extractText(body.content);
      if (text) {
        items.push({
          id: nextId("user"),
          kind: "user",
          timestamp: ts,
          text,
          raw: body,
        });
      }
      break;
    }
    case "tool_call": {
      items.push({
        id: nextId("tool"),
        kind: "tool_call",
        timestamp: ts,
        toolCallId: body.toolCallId ? String(body.toolCallId) : undefined,
        // ACP `kind` is read|edit|execute|search — keep separate from display title
        toolName: body.kind
          ? String(body.kind)
          : body.title
            ? String(body.title)
            : "tool",
        title: body.title ? String(body.title) : undefined,
        status: mapStatus(body.status) ?? "pending",
        input: body.rawInput ?? (body as { input?: unknown }).input,
        diffs: extractDiffs(body),
        raw: body,
      });
      break;
    }
    case "tool_call_update": {
      const diffs = extractDiffs(body);
      let status = mapStatus(body.status);
      const hasOutput =
        body.rawOutput != null || (body as { output?: unknown }).output != null;
      // Final-looking updates without status still count as completed
      if (!status && (hasOutput || diffs?.length)) status = "completed";
      items.push({
        id: nextId("toolu"),
        kind:
          hasOutput || status === "completed" || status === "failed"
            ? "tool_result"
            : "tool_call",
        timestamp: ts,
        toolCallId: body.toolCallId ? String(body.toolCallId) : undefined,
        toolName: body.kind ? String(body.kind) : undefined,
        title: body.title ? String(body.title) : undefined,
        status,
        // Keep input on updates when present (Grep pattern etc.)
        input: body.rawInput ?? (body as { input?: unknown }).input,
        output: body.rawOutput ?? (body as { output?: unknown }).output,
        diffs,
        text:
          typeof body.rawOutput === "string"
            ? body.rawOutput
            : extractText(body.content) || extractText(body.rawOutput) || undefined,
        raw: body,
      });
      break;
    }
    case "plan": {
      const entries = body.entries ?? (body as { plan?: unknown[] }).plan;
      const text = Array.isArray(entries)
        ? entries
            .map((e, i) => {
              if (typeof e === "string") return `${i + 1}. ${e}`;
              if (e && typeof e === "object") {
                const o = e as Record<string, unknown>;
                return `${i + 1}. ${o.content ?? o.title ?? o.text ?? JSON.stringify(e)}`;
              }
              return `${i + 1}. ${String(e)}`;
            })
            .join("\n")
        : extractText(body.content) || JSON.stringify(body);
      items.push({
        id: nextId("plan"),
        kind: "plan",
        timestamp: ts,
        text,
        raw: body,
      });
      break;
    }
    case "permission_request":
    case "request_permission": {
      // Handled via dedicated permission RPC usually; still surface in stream
      items.push({
        id: nextId("perm"),
        kind: "permission",
        timestamp: ts,
        title: body.title ? String(body.title) : "Permission required",
        text: extractText(body.content) || String((body as { description?: string }).description ?? ""),
        raw: body,
      });
      break;
    }
    default: {
      // Grok hook / session notifications — show in audit mode as system
      if (sessionUpdate && sessionUpdate !== "undefined") {
        const text =
          extractText(body.content) ||
          (body.title ? String(body.title) : "") ||
          sessionUpdate;
        if (text) {
          items.push({
            id: nextId("sys"),
            kind: "system",
            timestamp: ts,
            title: sessionUpdate,
            text,
            raw: body,
          });
        }
      }
      break;
    }
  }

  return { items, permission };
}

/**
 * Parse a full JSON-RPC notification line from grok agent stdio.
 */
export function parseJsonRpcLine(line: string): {
  kind: "notification" | "response" | "request" | "unknown";
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  updates: ParsedUpdateBatch;
} {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "unknown", updates: { items: [] } };
  }

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { kind: "unknown", updates: { items: [] } };
  }

  if (msg.method && msg.id !== undefined && !("result" in msg) && !("error" in msg)) {
    // Server request (e.g. permission)
    const method = String(msg.method);
    let updates: ParsedUpdateBatch = { items: [] };
    if (
      method.includes("permission") ||
      method === "session/request_permission" ||
      method === "request_permission"
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const toolCall = (params.toolCall ?? params.tool_call ?? {}) as Record<string, unknown>;
      const permission: PermissionRequest = {
        // Critical: keep JSON-RPC id type (number stays number) so respond() matches agent pending map.
        id: preserveJsonRpcId(msg.id),
        sessionId: String(params.sessionId ?? params.session_id ?? ""),
        toolCallId: toolCall.toolCallId
          ? String(toolCall.toolCallId)
          : toolCall.id
            ? String(toolCall.id)
            : undefined,
        title: String(toolCall.title ?? params.title ?? "Allow tool execution?"),
        description: String(
          toolCall.kind ??
            toolCall.description ??
            params.description ??
            JSON.stringify(toolCall.rawInput ?? toolCall.input ?? params, null, 2),
        ),
        options: Array.isArray(params.options)
          ? (params.options as Array<{ optionId?: string; name?: string; kind?: string }>).map(
              (o, i) => ({
                optionId: String(o.optionId ?? o.name ?? `opt-${i}`),
                name: String(o.name ?? o.optionId ?? `Option ${i + 1}`),
                kind: String(o.kind ?? "allow_once"),
              }),
            )
          : [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
              { optionId: "reject-once", name: "Deny", kind: "reject_once" },
            ],
        raw: params,
      };
      const planKind = classifyPlanPermission(permission);
      const planApproval = planKind
        ? permissionToPlanApproval(permission, planKind)
        : null;
      const userQuestions =
        !planKind && isAskUserQuestionPermission(permission)
          ? permissionToUserQuestions(permission)
          : null;
      // If permission is ask_user but questions only arrive later on tool input, still surface.
      if (userQuestions && userQuestions.questions.length === 0) {
        const fromInput = extractQuestions(params);
        if (fromInput.length) userQuestions.questions = fromInput;
      }
      updates = {
        items: [
          {
            id: nextId("perm"),
            kind: planKind ? "plan" : userQuestions ? "system" : "permission",
            timestamp: Date.now(),
            title:
              planApproval?.title ??
              (userQuestions
                ? `Ask ${userQuestions.questions.length || "?"} questions`
                : permission.title),
            text:
              planApproval?.planContent ||
              (userQuestions
                ? userQuestions.questions.map((q) => q.question).join("\n")
                : permission.description),
            toolCallId: permission.toolCallId,
            raw: params,
          },
        ],
        permission: planKind || userQuestions ? null : permission,
        planApproval,
        userQuestions,
      };
    } else if (isExitPlanExtMethod(method)) {
      // Grok intercepts exit_plan_mode and sends x.ai/exit_plan_mode to the client.
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const fields = extractPlanFields(params);
      const content = fields.content;
      const empty =
        !content.trim() || /^#?\s*No plan written yet/i.test(content);
      const planApproval: PlanApprovalRequest = {
        id: preserveJsonRpcId(msg.id),
        sessionId: String(params.sessionId ?? params.session_id ?? ""),
        kind: "exit_plan_mode",
        title: empty ? "No plan written yet" : "Plan ready for review",
        planContent: content,
        planFilePath: fields.path,
        empty,
        source: "ext_method",
        raw: params,
      };
      updates = {
        items: [
          {
            id: nextId("plan"),
            kind: "plan",
            timestamp: Date.now(),
            title: planApproval.title,
            text: content || "(empty plan)",
            raw: params,
          },
        ],
        planApproval,
      };
    } else if (isAskUserQuestionMethod(method)) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const questions = extractQuestions(params);
      const userQuestions: UserQuestionRequest = {
        id: preserveJsonRpcId(msg.id),
        sessionId: String(params.sessionId ?? params.session_id ?? ""),
        questions,
        source: "ext_method",
        toolCallId: params.toolCallId
          ? String(params.toolCallId)
          : params.tool_call_id
            ? String(params.tool_call_id)
            : undefined,
        title:
          questions.length > 0
            ? `Ask ${questions.length} question${questions.length === 1 ? "" : "s"}`
            : "Questions for you",
        raw: params,
      };
      updates = {
        items: [
          {
            id: nextId("ask"),
            kind: "system",
            timestamp: Date.now(),
            title: userQuestions.title,
            text: questions.map((q, i) => `${i + 1}. ${q.question}`).join("\n"),
            raw: params,
          },
        ],
        userQuestions,
      };
    }
    return {
      kind: "request",
      method,
      id: msg.id as string | number,
      params: msg.params,
      updates,
    };
  }

  if (msg.method && msg.id === undefined) {
    const method = String(msg.method);
    const params = (msg.params ?? {}) as Record<string, unknown>;
    let updatePayload: AcpSessionUpdate | null = null;

    if (
      method === "session/update" ||
      method === "session/updateNotification" ||
      method === "_x.ai/session/update" ||
      method === "x.ai/session/update" ||
      method === "_x.ai/session_notification" ||
      method === "x.ai/session_notification"
    ) {
      updatePayload = (params.update as AcpSessionUpdate) ?? (params as AcpSessionUpdate);
    } else if (params.sessionUpdate || params.update) {
      updatePayload = (params.update as AcpSessionUpdate) ?? (params as AcpSessionUpdate);
    }

    const updates = updatePayload
      ? parseSessionUpdate(updatePayload, {
          sessionId: params.sessionId ? String(params.sessionId) : undefined,
        })
      : { items: [] };

    return {
      kind: "notification",
      method,
      params,
      updates,
    };
  }

  if ("result" in msg || "error" in msg) {
    return {
      kind: "response",
      id: msg.id as string | number | undefined,
      result: msg.result,
      error: msg.error,
      updates: { items: [] },
    };
  }

  return { kind: "unknown", updates: { items: [] } };
}

/**
 * Merge consecutive agent_text / thought chunks for cleaner rendering.
 */
export function coalesceStreamItems(items: StreamItem[]): StreamItem[] {
  if (items.length === 0) return [];
  const out: StreamItem[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    // Drop ACP user_message echo when we already optimistically painted the same text
    if (
      last &&
      last.kind === "user" &&
      item.kind === "user" &&
      (last.text || "").trim() === (item.text || "").trim()
    ) {
      continue;
    }
    if (
      last &&
      last.kind === item.kind &&
      (item.kind === "agent_text" || item.kind === "thought") &&
      last.text != null &&
      item.text != null
    ) {
      // Replace object so React always sees a new reference (in-place mutate
      // left markdown stuck until full remount / app reopen).
      // joinAgentTextChunks avoids gluing ``` fences to the next turn's prose.
      out[out.length - 1] = {
        ...last,
        text:
          item.kind === "agent_text"
            ? joinAgentTextChunks(last.text || "", item.text || "")
            : (last.text || "") + item.text,
        timestamp: item.timestamp,
      };
      continue;
    }
    // Merge tool_call_update into prior tool_call with same id
    if (
      last &&
      item.toolCallId &&
      last.toolCallId === item.toolCallId &&
      (last.kind === "tool_call" || last.kind === "tool_result") &&
      (item.kind === "tool_call" || item.kind === "tool_result")
    ) {
      out[out.length - 1] = {
        ...last,
        ...item,
        id: last.id,
        kind: item.kind === "tool_result" ? "tool_result" : last.kind,
        status: item.status ?? last.status,
        output: item.output ?? last.output,
        diffs: item.diffs ?? last.diffs,
        text: item.text ?? last.text,
        title: item.title ?? last.title,
        input: item.input ?? last.input,
        toolName: item.toolName || last.toolName,
        raw: item.raw ?? last.raw,
        timestamp: item.timestamp || last.timestamp,
      };
      continue;
    }
    out.push({ ...item });
  }
  return out;
}
