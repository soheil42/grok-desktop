/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import App from "../App";

function mount(): HTMLDivElement {
  const el = document.createElement("div");
  el.id = "root";
  document.body.appendChild(el);
  return el;
}

describe("App shell mount", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    // Ensure no electron bridge — store uses fallback
    delete window.grokDesktop;
    container = mount();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("mounts multi-panel command center (projects, threads, chat, composer)", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    // Allow bootstrap effect
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const shell = document.querySelector('[data-testid="app-shell"]');
    expect(shell).toBeTruthy();

    expect(document.querySelector('[data-testid="projects-sidebar"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="threads-sidebar"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="chat-panel"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="composer"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="prompt-input"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="main-grid"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="settings-toggle"]')).toBeNull();
    expect(document.querySelector(".settings-bar")).toBeNull();

    root.unmount();
  });

  it("applies shell direction from locale without a settings panel", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const shell = document.querySelector('[data-testid="app-shell"]') as HTMLElement;
    expect(shell).toBeTruthy();
    expect(shell.getAttribute("dir")).toMatch(/^(ltr|rtl)$/);

    root.unmount();
  });
});
