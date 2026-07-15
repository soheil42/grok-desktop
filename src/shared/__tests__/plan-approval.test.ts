import { describe, expect, it } from "vitest";
import {
  buildExitPlanModeExtResult,
  classifyPlanPermission,
  extractPlanFields,
  isExitPlanExtMethod,
  permissionToPlanApproval,
  planDecisionToOptionId,
} from "../plan-approval.js";
import type { PermissionRequest } from "../types.js";
import { parseJsonRpcLine, __resetParserIds } from "../acp-parser.js";

function perm(partial: Partial<PermissionRequest>): PermissionRequest {
  return {
    id: 1,
    sessionId: "s1",
    title: "tool",
    description: "",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
    ],
    raw: {},
    ...partial,
  };
}

describe("plan-approval helpers", () => {
  it("classifies exit_plan_mode permissions", () => {
    expect(
      classifyPlanPermission(
        perm({ title: "exit_plan_mode", description: "Present plan" }),
      ),
    ).toBe("exit_plan_mode");
    expect(
      classifyPlanPermission(
        perm({
          title: "Allow tool",
          raw: { toolCall: { title: "ExitPlanMode", kind: "other" } },
        }),
      ),
    ).toBe("exit_plan_mode");
  });

  it("classifies enter_plan_mode permissions", () => {
    expect(
      classifyPlanPermission(perm({ title: "enter_plan_mode" })),
    ).toBe("enter_plan_mode");
  });

  it("does not classify normal tools as plan", () => {
    expect(
      classifyPlanPermission(
        perm({ title: "run_terminal_command", description: "ls" }),
      ),
    ).toBeNull();
  });

  it("extracts planContent and plan_file_path", () => {
    const fields = extractPlanFields({
      planContent: "# Plan\n\nDo the thing",
      plan_file_path: "/tmp/plan.md",
    });
    expect(fields.content).toContain("Do the thing");
    expect(fields.path).toBe("/tmp/plan.md");
  });

  it("builds ext_method result for approve/reject/abandon", () => {
    expect(buildExitPlanModeExtResult("approved").outcome).toBe("approved");
    expect(buildExitPlanModeExtResult("abandoned").abandoned).toBe(true);
    expect(String(buildExitPlanModeExtResult("abandoned").message)).toMatch(
      /abandon/i,
    );
    const rej = buildExitPlanModeExtResult("rejected", "use REST not GraphQL");
    expect(rej.outcome).toBe("rejected");
    expect(String(rej.feedback)).toContain("REST");
    expect(String(rej.message)).toMatch(/does not want to exit/i);
    const apc = buildExitPlanModeExtResult("approved", "reuse auth");
    expect(String(apc.message)).toContain("reuse auth");
  });

  it("builds follow-up prompts matching CLI side effects", async () => {
    const { planDecisionFollowUpPrompt } = await import("../plan-approval.js");
    expect(planDecisionFollowUpPrompt("approved", "exit_plan_mode")).toBeNull();
    expect(
      planDecisionFollowUpPrompt("approved", "exit_plan_mode", "note"),
    ).toMatch(/approved/i);
    expect(planDecisionFollowUpPrompt("rejected", "exit_plan_mode", "fix")).toMatch(
      /revise/i,
    );
    expect(planDecisionFollowUpPrompt("abandoned", "exit_plan_mode")).toMatch(
      /abandoned/i,
    );
  });

  it("maps decisions to option ids", () => {
    const opts = perm({}).options;
    expect(planDecisionToOptionId("approved", opts)).toBe("allow-once");
    expect(planDecisionToOptionId("rejected", opts)).toBe("reject-once");
  });

  it("detects exit plan ext methods", () => {
    expect(isExitPlanExtMethod("x.ai/exit_plan_mode")).toBe(true);
    expect(isExitPlanExtMethod("session/request_permission")).toBe(false);
  });
});

describe("acp-parser plan approval", () => {
  it("parses x.ai/exit_plan_mode as planApproval ext_method", () => {
    __resetParserIds();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "x.ai/exit_plan_mode",
      params: {
        sessionId: "sess-1",
        planContent: "## Approach\n\nUse a modal.",
        plan_file_path: "/home/.grok/sessions/x/plan.md",
      },
    });
    const parsed = parseJsonRpcLine(line);
    expect(parsed.kind).toBe("request");
    expect(parsed.updates.planApproval?.kind).toBe("exit_plan_mode");
    expect(parsed.updates.planApproval?.source).toBe("ext_method");
    expect(parsed.updates.planApproval?.planContent).toContain("modal");
    expect(parsed.updates.planApproval?.id).toBe(7);
    expect(parsed.updates.permission).toBeFalsy();
  });

  it("routes exit_plan_mode permission to planApproval not permission", () => {
    __resetParserIds();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: {
          title: "exit_plan_mode",
          kind: "other",
          rawInput: {},
        },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    const parsed = parseJsonRpcLine(line);
    expect(parsed.updates.planApproval?.kind).toBe("exit_plan_mode");
    expect(parsed.updates.planApproval?.source).toBe("permission");
    expect(parsed.updates.permission).toBeNull();
  });

  it("permissionToPlanApproval marks empty plans", () => {
    const p = permissionToPlanApproval(
      perm({ title: "exit_plan_mode", description: "exit_plan_mode" }),
      "exit_plan_mode",
    );
    expect(p.empty).toBe(true);
    expect(p.title).toMatch(/No plan/i);
  });
});
