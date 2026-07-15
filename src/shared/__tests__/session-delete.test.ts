import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deleteSessionTree } from "../session-delete.js";

describe("deleteSessionTree", () => {
  it("deletes session dir and child with parent_session_id", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-del-"));
    const group = path.join(home, "sessions", "sample");
    const parent = path.join(group, "parent-id");
    const child = path.join(group, "child-id");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(
      path.join(parent, "summary.json"),
      JSON.stringify({ info: { id: "parent-id" } }),
    );
    fs.writeFileSync(
      path.join(child, "summary.json"),
      JSON.stringify({
        info: { id: "child-id" },
        parent_session_id: "parent-id",
        session_kind: "subagent_fork",
      }),
    );
    fs.mkdirSync(path.join(parent, "subagents", "child-id"), { recursive: true });

    const result = deleteSessionTree(home, {
      sessionId: "parent-id",
      sessionPath: parent,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(parent)).toBe(false);
    expect(fs.existsSync(child)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
