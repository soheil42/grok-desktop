import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listProjects,
  listSessionsInGroup,
  decodeEncodedCwd,
  encodeCwd,
  projectLabel,
  detectAuth,
  sessionsRoot,
  isMainHumanSession,
} from "../session-index.js";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureHome = path.resolve(__dirname, "../../../fixtures");

describe("session-index", () => {
  it("decodes URL-encoded cwd segments", () => {
    const encoded = encodeURIComponent("/Users/dev/projects/demo-app");
    expect(decodeEncodedCwd(encoded)).toBe("/Users/dev/projects/demo-app");
  });

  it("encodeCwd is stable for absolute paths", () => {
    const cwd = "/tmp/demo";
    expect(decodeURIComponent(encodeCwd(cwd))).toContain("demo");
  });

  it("projectLabel uses basename", () => {
    expect(projectLabel("/Users/dev/my-app")).toBe("my-app");
  });

  it("lists projects and sessions from fixture sessions tree", () => {
    // fixtures/sessions/sample-cwd/...
    const projects = listProjects(fixtureHome);
    expect(projects.length).toBeGreaterThanOrEqual(1);
    const demo = projects.find((p) => p.encodedCwd === "sample-cwd" || p.cwd.includes("demo-app"));
    expect(demo).toBeTruthy();
    expect(demo!.sessionCount).toBeGreaterThanOrEqual(1);

    const groupDir = path.join(sessionsRoot(fixtureHome), demo!.encodedCwd);
    const sessions = listSessionsInGroup(groupDir, demo!.cwd);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].title).toMatch(/auth|Wire|Demo/i);
    expect(sessions[0].id).toBe("sample-session");
    expect(sessions[0].modelId).toBe("grok-4.5");
  });

  it("isMainHumanSession filters subagents and forks", () => {
    expect(isMainHumanSession({})).toBe(true);
    expect(isMainHumanSession({ session_kind: null })).toBe(true);
    expect(isMainHumanSession({ session_kind: "subagent" })).toBe(false);
    expect(isMainHumanSession({ session_kind: "subagent_fork" })).toBe(false);
    expect(isMainHumanSession({ session_kind: "subagent_resume" })).toBe(false);
    expect(
      isMainHumanSession({ parent_session_id: "019f-parent-id" }),
    ).toBe(false);
    expect(
      isMainHumanSession({
        generated_title: "You are the Goal Summarizer for the xAI Grok Build",
      }),
    ).toBe(false);
    expect(
      isMainHumanSession({
        generated_title: "Grok CLI Research: Build RTL Desktop App",
      }),
    ).toBe(true);
  });

  it("detectAuth reports missing auth honestly on empty home", () => {
    const emptyHome = path.join(fixtureHome, "empty-home-should-not-exist-xyz");
    const result = detectAuth(emptyHome);
    expect(result.loggedIn).toBe(false);
    expect(result.method).toBe("none");
    expect(result.message.toLowerCase()).toMatch(/not signed|login|api/);
  });

  it("detectAuth sees fixture-less but real auth.json shape when present in temp", () => {
    const tmp = path.join(fixtureHome, "_tmp_auth_home");
    fs.mkdirSync(tmp, { recursive: true });
    const authPath = path.join(tmp, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ "https://auth.x.ai::test": { access_token: "x" } }));
    try {
      const result = detectAuth(tmp);
      expect(result.loggedIn).toBe(true);
      expect(result.method).toBe("cli-session");
      expect(result.hasAuthFile).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
