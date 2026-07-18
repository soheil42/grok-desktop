import { describe, expect, it, vi } from "vitest";
import { GrokAcpClient } from "../acp-client.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Drive the shipped GrokAcpClient.handleLine / respond path without a live grok binary.
 * We stub stdin writes and feed agent→client requests as if they came from stdout.
 */
describe("GrokAcpClient client-request handling (shipped class)", () => {
  it("retains the selected reasoning effort for process/session settings", () => {
    const client = new GrokAcpClient({
      cwd: process.cwd(),
      alwaysApprove: false,
      reasoningEffort: "high",
    });
    expect(client.settings.reasoningEffort).toBe("high");
  });

  it("captures the model catalog advertised in initialize _meta.modelState", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });

    (
      client as unknown as {
        captureSessionSettings: (result: Record<string, unknown>) => void;
      }
    ).captureSessionSettings({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              modelId: "grok-4.5",
              name: "Grok 4.5",
              description: "Frontier model",
              _meta: {
                totalContextTokens: 500_000,
                supportsReasoningEffort: true,
                reasoningEffort: "high",
                reasoningEfforts: [
                  { id: "high", value: "high", label: "High Effort", default: true },
                  { id: "medium", value: "medium", label: "Medium Effort" },
                  { id: "low", value: "low", label: "Low Effort" },
                ],
              },
            },
            {
              modelId: "grok-composer-2.5-fast",
              name: "Composer 2.5",
              description: "Coding model",
            },
          ],
        },
      },
    });

    expect(client.settings.currentModelId).toBe("grok-4.5");
    expect(client.settings.models).toEqual([
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        description: "Frontier model",
        totalContextTokens: 500_000,
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { value: "high", name: "High Effort", description: undefined },
          { value: "medium", name: "Medium Effort", description: undefined },
          { value: "low", name: "Low Effort", description: undefined },
        ],
        available: true,
      },
      {
        id: "grok-composer-2.5-fast",
        name: "Composer 2.5",
        description: "Coding model",
        supportsReasoningEffort: false,
        reasoningEffort: undefined,
        reasoningEfforts: undefined,
        totalContextTokens: undefined,
        available: true,
      },
    ]);
    expect(client.settings.reasoningEffort).toBe("high");
  });

  it("switches Composer using Grok's exact ACP model id and clears Grok-only effort", async () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const capture = (
      client as unknown as {
        captureSessionSettings: (result: Record<string, unknown>) => void;
      }
    ).captureSessionSettings.bind(client);
    capture({
      _meta: {
        modelState: {
          currentModelId: "grok-4.5",
          availableModels: [
            {
              modelId: "grok-4.5",
              name: "Grok 4.5",
              _meta: {
                supportsReasoningEffort: true,
                reasoningEffort: "high",
                reasoningEfforts: [{ value: "high", label: "High Effort" }],
              },
            },
            {
              modelId: "grok-composer-2.5-fast",
              name: "Composer 2.5",
              _meta: { totalContextTokens: 200_000, agentType: "cursor" },
            },
          ],
        },
      },
    });
    const request = vi
      .spyOn(client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }, "request")
      .mockResolvedValue({ ok: true });

    await client.setSessionModel("grok-composer-2.5-fast", "session-live");

    expect(request).toHaveBeenCalledWith("session/set_model", {
      sessionId: "session-live",
      modelId: "grok-composer-2.5-fast",
    });
    expect(client.settings.currentModelId).toBe("grok-composer-2.5-fast");
    expect(client.settings.reasoningEffort).toBeUndefined();
  });

  it("preserves the initialize model catalog when session responses omit it", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const capture = (
      client as unknown as {
        captureSessionSettings: (result: Record<string, unknown>) => void;
      }
    ).captureSessionSettings.bind(client);

    capture({
      _meta: {
        modelState: {
          currentModelId: "grok-4.5",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            { modelId: "grok-composer-2.5-fast", name: "Composer 2.5" },
          ],
        },
      },
    });
    capture({ sessionId: "session-1" });

    expect(client.settings.models.map((model) => model.name)).toEqual([
      "Grok 4.5",
      "Composer 2.5",
    ]);
  });

  it("applies an asynchronous models/update catalog refresh", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const updates: unknown[] = [];
    client.on("settings", (settings) => updates.push(settings));

    client.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "_x.ai/models/update",
      params: {
        modelState: {
          currentModelId: "grok-composer-2.5-fast",
          availableModels: [
            { modelId: "grok-4.5", name: "Grok 4.5" },
            {
              modelId: "grok-composer-2.5-fast",
              name: "Composer 2.5",
              _meta: { totalContextTokens: 200_000, agentType: "cursor" },
            },
          ],
        },
      },
    }));

    expect(updates).toHaveLength(1);
    expect(client.settings.currentModelId).toBe("grok-composer-2.5-fast");
    expect(client.settings.models.map((model) => model.id)).toContain(
      "grok-composer-2.5-fast",
    );
    expect(client.settings.reasoningEffort).toBeUndefined();
  });

  it("keeps the authoritative Grok slash-command catalog and refreshes live updates", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const capture = (
      client as unknown as {
        captureSessionSettings: (result: Record<string, unknown>) => void;
      }
    ).captureSessionSettings.bind(client);
    capture({
      _meta: {
        availableCommands: [
          { name: "compact", description: "Compress context", input: { hint: "what to preserve" } },
          { name: "context", description: "Show context usage", input: null },
        ],
      },
    });
    expect(client.settings.availableCommands).toEqual([
      { name: "compact", description: "Compress context", inputHint: "what to preserve" },
      { name: "context", description: "Show context usage", inputHint: undefined },
    ]);

    const settings = vi.fn();
    client.on("settings", settings);
    client.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "goal", description: "Manage a goal", input: null }],
        },
      },
    }));
    expect(client.settings.availableCommands.map((command) => command.name)).toEqual(["goal"]);
    expect(settings).toHaveBeenCalledOnce();
  });

  it("sends clipboard images as ACP image content blocks", async () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const request = vi
      .spyOn(client as unknown as { request: (method: string, params: unknown) => Promise<unknown> }, "request")
      .mockResolvedValue({ ok: true });

    await client.prompt("inspect this", "session-1", [
      { mimeType: "image/png", data: "aGVsbG8=" },
    ]);

    expect(request).toHaveBeenCalledWith("session/prompt", {
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "inspect this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });
  });

  it("answers fs/read_text_file with a JSON-RPC response using the original numeric id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-acp-cli-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "from-disk");
    const client = new GrokAcpClient({ cwd: dir, alwaysApprove: false });

    const writes: string[] = [];
    // Inject a fake process stdin
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => {
          writes.push(s);
        },
      },
    };
    (client as unknown as { cwd: string }).cwd = dir;

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "fs/read_text_file",
        params: { path: "a.txt" },
      }),
    );

    await vi.waitFor(() => expect(writes.length).toBe(1));
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(99);
    expect(typeof msg.id).toBe("number");
    expect(msg.result.content).toBe("from-disk");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers terminal/create with real process + ACP shape", async () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const writes: string[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "term-1",
        method: "terminal/create",
        params: { command: "echo", args: ["ok"] },
      }),
    );

    await vi.waitFor(() => expect(writes.length).toBe(1));
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe("term-1");
    expect(typeof msg.id).toBe("string");
    expect(msg.result.terminalId).toBeTruthy();
    // Must not include legacy stub fields that break deserialize
    expect(msg.result.supported).toBeUndefined();
  });

  it("emits permission with numeric id and responds with same type when alwaysApprove", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: true });
    const writes: string[] = [];
    const perms: unknown[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };
    client.on("permission", (p) => perms.push(p));

    client.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "s",
          toolCall: { title: "run", kind: "execute" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
        },
      }),
    );

    expect(perms.length).toBe(1);
    expect((perms[0] as { id: unknown }).id).toBe(7);
    expect(typeof (perms[0] as { id: unknown }).id).toBe("number");
    expect(writes.length).toBe(1);
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(7);
    expect(typeof msg.id).toBe("number");
    expect(msg.result.outcome.optionId).toBe("allow-once");
  });

  it("manual respond() preserves id type for UI approve path", () => {
    const client = new GrokAcpClient({ cwd: process.cwd(), alwaysApprove: false });
    const writes: string[] = [];
    (client as unknown as { proc: { stdin: { writable: boolean; write: (s: string) => void } } }).proc = {
      stdin: {
        writable: true,
        write: (s: string) => writes.push(s),
      },
    };

    // Simulate UI calling respond with permission.id from parser
    client.respond(42, {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    const msg = JSON.parse(writes[0]);
    expect(msg.id).toBe(42);
    expect(typeof msg.id).toBe("number");
  });
});
