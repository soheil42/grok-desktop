import { describe, expect, it } from "vitest";
import {
  parseMessageContent,
  sanitizeUserMessageText,
  summarizeSystemReminder,
} from "../message-content.js";

describe("system-reminder handling", () => {
  it("hides pure system-reminder messages", () => {
    const raw = `<system-reminder>
Background task "abc" completed (terminated by signal timeout).
Command: npm run build
</system-reminder>`;
    expect(sanitizeUserMessageText(raw)).toBeNull();
  });

  it("strips system-reminder from mixed user text", () => {
    const raw = `hello world
<system-reminder>
The following skills are available
</system-reminder>
please fix the bug`;
    const cleaned = sanitizeUserMessageText(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned!.text).toContain("hello world");
    expect(cleaned!.text).toContain("please fix the bug");
    expect(cleaned!.text).not.toContain("system-reminder");
    expect(cleaned!.text).not.toContain("skills are available");
  });

  it("extracts image chips", () => {
    const parsed = parseMessageContent(
      "look at [Image #1] and [Image #2] please",
    );
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0].index).toBe(1);
    expect(parsed.text).toMatch(/look at/);
    expect(parsed.text).not.toMatch(/\[Image/);
  });

  it("summarizes background task reminders", () => {
    const s = summarizeSystemReminder(
      'Background task "019f66f3" completed (terminated by signal timeout).\nCommand: foo',
    );
    expect(s).toMatch(/Background task finished/);
  });
});
