/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StreamItemView } from "../components/StreamItemView";
import { coalesceStreamItems } from "@shared/acp-parser";
import type { StreamItem } from "@shared/types";

describe("streaming Markdown rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("replaces partial markup with the final heading, emphasis, table, and fence", () => {
    const source = [
      "## Status",
      "",
      "The build is **ready**.",
      "",
      "| Area | Result |",
      "|---|---|",
      "| Renderer | fixed |",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");

    // Cut inside Markdown delimiters, not merely between complete lines.
    const revisions = [1, 2, 5, 16, 27, 42, 55, 70, source.length];
    for (const end of revisions) {
      act(() => {
        root.render(
          <StreamItemView
            item={{
              id: "same-live-item",
              kind: "agent_text",
              timestamp: 1,
              text: source.slice(0, end),
            }}
          />,
        );
      });
    }

    expect(container.querySelector("h2")?.textContent).toBe("Status");
    expect(container.querySelector("strong")?.textContent).toBe("ready");
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelector("tbody td")?.textContent).toBe("Renderer");
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const ok = true;",
    );
    expect(container.textContent).not.toContain("|---|---|");
  });

  it("remounts Markdown when a revision has the same length", () => {
    act(() => {
      root.render(
        <StreamItemView
          item={{
            id: "same-live-item",
            kind: "agent_text",
            timestamp: 1,
            text: "**ok**",
          }}
        />,
      );
    });
    const firstMarkdownRoot = container.querySelector(".md");
    expect(container.querySelector("strong")?.textContent).toBe("ok");

    act(() => {
      root.render(
        <StreamItemView
          item={{
            id: "same-live-item",
            kind: "agent_text",
            timestamp: 2,
            text: "## yes",
          }}
        />,
      );
    });

    expect(container.querySelector("h2")?.textContent).toBe("yes");
    expect(container.querySelector(".md")).not.toBe(firstMarkdownRoot);
  });

  it("renders the reported whitespace-trimmed ACP blocks as Markdown", () => {
    const chunks = [
      "# Database structure",
      "There are **two layers**:",
      "1. **What actually runs today** — TypeORM entities",
      "2. **Target design** — full OTA schema",
      "Below is mainly **what’s implemented now**.",
      "---",
      "## Global rules (every table)",
      "| Rule | Detail |",
      "|---|---|",
      "| **IDs** | Internal `BIGSERIAL id` |",
    ];
    const items: StreamItem[] = chunks.map((text, index) => ({
      id: `chunk-${index}`,
      kind: "agent_text",
      timestamp: index,
      text,
    }));
    const message = coalesceStreamItems(items)[0];

    act(() => root.render(<StreamItemView item={message} />));

    expect(container.querySelector("h1")?.textContent).toBe("Database structure");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Global rules (every table)",
    );
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.textContent).not.toContain("---##");
  });
});
