import { describe, expect, it } from "vitest";
import { parseJsonRpcLine, __resetParserIds } from "../acp-parser.js";
import {
  buildAskUserQuestionResult,
  buildSkipInterviewResult,
  extractQuestions,
  isAskUserQuestionMethod,
  looksLikeAskUserQuestion,
} from "../user-questions.js";

describe("user-questions", () => {
  it("detects Ask N questions titles", () => {
    expect(looksLikeAskUserQuestion("Ask 4 questions")).toBe(true);
    expect(looksLikeAskUserQuestion("ask_user_question")).toBe(true);
    expect(looksLikeAskUserQuestion("run_terminal_command")).toBe(false);
  });

  it("extracts questions from real Grok tool_call rawInput", () => {
    const qs = extractQuestions({
      title: "Ask 4 questions",
      rawInput: {
        variant: "AskUserQuestion",
        questions: [
          {
            question: "What should this agent do?",
            options: [
              {
                label: "Code reviewer",
                description: "Analyze code for quality",
              },
              { label: "Code fixer" },
            ],
            multiSelect: null,
          },
          {
            question: "Where should the agent live?",
            options: [
              { label: "Personal (~/.claude/agents/)" },
              { label: "Project (.claude/agents/)" },
            ],
          },
        ],
      },
    });
    expect(qs).toHaveLength(2);
    expect(qs[0].options[0].label).toBe("Code reviewer");
    expect(qs[0].options[0].description).toContain("Analyze");
  });

  it("builds pure Accepted enum with string-array answers", () => {
    const qs = extractQuestions({
      questions: [
        {
          id: "q1",
          question: "Pick one",
          options: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
          ],
        },
      ],
    });
    const result = buildAskUserQuestionResult(qs, { q1: "b" });
    // Must be pure enum — no sibling keys
    expect(Object.keys(result)).toEqual(["Accepted"]);
    const body = result.Accepted as {
      answers: Record<string, string[]>;
      partial_answers: null;
    };
    expect(body.answers["Pick one"]).toEqual(["Beta"]);
    expect(body.partial_answers).toBeNull();
  });

  it("freeform Other uses annotations.notes", () => {
    const qs = extractQuestions({
      questions: [
        {
          id: "q1",
          question: "Custom?",
          options: [{ id: "a", label: "Yes" }],
        },
      ],
    });
    const result = buildAskUserQuestionResult(
      qs,
      { q1: "__other__" },
      { q1: "Something custom" },
    );
    const body = result.Accepted as {
      answers: Record<string, string[]>;
      annotations: Record<string, { notes: string }>;
    };
    expect(body.answers["Custom?"]).toEqual(["Other"]);
    expect(body.annotations["Custom?"].notes).toBe("Something custom");
  });

  it("SkipInterview is pure enum", () => {
    expect(buildSkipInterviewResult()).toEqual({ SkipInterview: null });
  });

  it("parses x.ai/ask_user_question ext method", () => {
    __resetParserIds();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "x.ai/ask_user_question",
      params: {
        sessionId: "s1",
        questions: [
          {
            question: "Ship now?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
    });
    expect(isAskUserQuestionMethod("x.ai/ask_user_question")).toBe(true);
    const parsed = parseJsonRpcLine(line);
    expect(parsed.updates.userQuestions?.questions).toHaveLength(1);
    expect(parsed.updates.userQuestions?.questions[0].question).toBe("Ship now?");
    expect(parsed.updates.userQuestions?.id).toBe(3);
    expect(parsed.updates.userQuestions?.source).toBe("ext_method");
  });
});
