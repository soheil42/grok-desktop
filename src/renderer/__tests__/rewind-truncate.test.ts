import { describe, expect, it } from "vitest";
import { truncateHistoryBeforeUserPrompt } from "../store";
import type { StreamItem } from "@shared/types";

function item(kind: StreamItem["kind"], text: string, id: string): StreamItem {
  return { id, kind, timestamp: 0, text };
}

describe("truncateHistoryBeforeUserPrompt", () => {
  const stream: StreamItem[] = [
    item("user", "First", "u0"),
    item("agent_text", "A1", "a0"),
    item("user", "Second", "u1"),
    item("agent_text", "A2", "a1"),
    item("user", "Third", "u2"),
    item("agent_text", "A3", "a2"),
  ];

  it("drops the selected user message and everything after (CLI parity)", () => {
    const out = truncateHistoryBeforeUserPrompt(stream, 1, "Second");
    expect(out.map((i) => i.id)).toEqual(["u0", "a0"]);
  });

  it("rewinding to first message clears the stream", () => {
    const out = truncateHistoryBeforeUserPrompt(stream, 0, "First");
    expect(out).toEqual([]);
  });

  it("falls back to prompt text when index is past end", () => {
    const out = truncateHistoryBeforeUserPrompt(stream, 99, "Second");
    expect(out.map((i) => i.id)).toEqual(["u0", "a0"]);
  });
});
