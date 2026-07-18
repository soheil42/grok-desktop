/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandQuery,
  ContextUsageMeter,
  formatCompactTokens,
  SlashCommandPalette,
} from "../components/SlashCommandPalette";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("slash command palette", () => {
  it("opens only for an unfinished command at the beginning of the composer", () => {
    expect(commandQuery("/")).toBe("");
    expect(commandQuery("/comp")).toBe("comp");
    expect(commandQuery("hello /comp")).toBeNull();
    expect(commandQuery("/compact now")).toBeNull();
  });

  it("supports arrow navigation and Enter insertion", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const onSelect = vi.fn();
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <SlashCommandPalette
          draft="/"
          commands={[
            { name: "compact", description: "Compress context" },
            { name: "goal", description: "Manage a goal", inputHint: "<objective>" },
          ]}
          inputRef={{ current: input }}
          onSelect={onSelect}
        />,
      );
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("/goal ");
    await act(async () => root.unmount());
  });
});

describe("context usage", () => {
  it("formats Grok token counters compactly", () => {
    expect(formatCompactTokens(950)).toBe("950");
    expect(formatCompactTokens(74_912)).toBe("75K");
    expect(formatCompactTokens(500_000)).toBe("500K");
  });

  it("shows an honest unknown state without a reported context window", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<ContextUsageMeter />));
    expect(host.textContent).toContain("Context —");
    expect(host.querySelector(".context-usage")?.getAttribute("title")).toMatch(/not been reported/i);
    await act(async () => root.unmount());
  });
});
