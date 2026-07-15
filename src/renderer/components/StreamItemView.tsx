import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MessageImage, StreamItem } from "@shared/types";
import type { TimelineEntry } from "@shared/stream-timeline";
import { toolShortLabel } from "@shared/stream-timeline";
import { parseMessageContent } from "@shared/message-content";
import { buildToolPreview } from "@shared/tool-preview";
import {
  codeRegionProps,
  detectTextDirection,
  proseRegionProps,
} from "@shared/rtl";

type Mode = "clean" | "transparent" | "audit";

function Md({ children }: { children: string }) {
  const prose = proseRegionProps(children);
  if (!children?.trim()) return null;
  // unicode-bidi: plaintext helps mixed Persian + inline code render in order
  return (
    <div
      className={`md ${prose.className}`}
      dir={prose.dir}
      lang={prose.lang}
      style={{ unicodeBidi: "plaintext" }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target="_blank" rel="noreferrer" className="ltr-isolate" dir="ltr">
              {c}
            </a>
          ),
          code: ({ className, children: c, ...props }) => {
            const inline = !className;
            if (inline) {
              return (
                <code
                  className="md-inline-code code-font ltr-isolate"
                  dir="ltr"
                  style={{ unicodeBidi: "isolate" }}
                  {...props}
                >
                  {c}
                </code>
              );
            }
            return (
              <code className={`${className || ""} code-font`} dir="ltr" {...props}>
                {c}
              </code>
            );
          },
          pre: ({ children: c }) => (
            <pre className="md-pre ltr-isolate code-font" dir="ltr">
              {c}
            </pre>
          ),
          table: ({ children: c }) => (
            <div className="md-table-wrap ltr-isolate" dir="ltr">
              <table>{c}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Professional image strip above a user message (Codex/Grok web style). */
function ImageGallery({ images }: { images: MessageImage[] }) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const next: Record<string, string> = {};
      for (let i = 0; i < images.length; i++) {
        const im = images[i];
        const key = im.dataUrl || im.path || `i-${i}`;
        if (im.dataUrl) {
          next[key] = im.dataUrl;
          continue;
        }
        if (im.path && window.grokDesktop?.readMedia) {
          try {
            const data = await window.grokDesktop.readMedia(im.path);
            if (data && !cancelled) next[key] = data;
          } catch {
            // ignore
          }
        }
      }
      if (!cancelled) setSrcs(next);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [images]);

  if (!images.length) return null;

  return (
    <>
      <div className="img-gallery">
        {images.map((im, i) => {
          const key = im.dataUrl || im.path || `i-${i}`;
          const src = srcs[key];
          return (
            <button
              key={key}
              type="button"
              className="img-tile"
              onClick={() => src && setLightbox(src)}
              title={im.label}
            >
              {src ? (
                <img src={src} alt={im.label} loading="lazy" />
              ) : (
                <div className="img-placeholder">
                  <span>{im.label || `Image ${i + 1}`}</span>
                </div>
              )}
              <span className="img-cap">{im.label || `Image ${i + 1}`}</span>
            </button>
          );
        })}
      </div>
      {lightbox && (
        <div
          className="img-lightbox"
          role="dialog"
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => e.key === "Escape" && setLightbox(null)}
        >
          <img src={lightbox} alt="" />
        </div>
      )}
    </>
  );
}

function DiffLines({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const code = codeRegionProps();
  const base = path.split(/[/\\]/).pop() || path;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // Cap display length for huge edits
  const max = 80;
  const oldShow = oldLines.slice(0, max);
  const newShow = newLines.slice(0, max);
  const truncated = oldLines.length > max || newLines.length > max;

  return (
    <div className="diff-view code-font" dir={code.dir} style={code.style}>
      <div className="path">{base}</div>
      <div className="diff-meta">
        <span className="del-count">−{oldLines.length}</span>
        <span className="add-count">+{newLines.length}</span>
      </div>
      <pre className="diff-pre">
        {oldShow.map((line, i) => (
          <div key={`o${i}`} className="del">
            − {line || " "}
          </div>
        ))}
        {newShow.map((line, i) => (
          <div key={`n${i}`} className="add">
            + {line || " "}
          </div>
        ))}
        {truncated && <div className="diff-more">… truncated</div>}
      </pre>
    </div>
  );
}

function CodeBlock({
  path,
  content,
  label,
}: {
  path?: string;
  content: string;
  label?: string;
}) {
  const code = codeRegionProps();
  const base = path ? path.split(/[/\\]/).pop() : label || "code";
  return (
    <div className="code-block code-font" dir={code.dir} style={code.style}>
      <div className="code-block-head">
        <span>{base}</span>
      </div>
      <pre>{content}</pre>
    </div>
  );
}

function Diamond() {
  return (
    <span className="diamond" aria-hidden>
      ◆
    </span>
  );
}

function ToolBody({ item, audit }: { item: StreamItem; audit?: boolean }) {
  const preview = buildToolPreview(item);
  const code = codeRegionProps();

  if (preview.kind === "diff") {
    return (
      <div className="tool-body tool-body-pretty">
        <DiffLines path={preview.path} oldText={preview.oldText} newText={preview.newText} />
      </div>
    );
  }
  if (preview.kind === "code") {
    return (
      <div className="tool-body tool-body-pretty">
        <CodeBlock path={preview.path} content={preview.content} label={preview.label} />
      </div>
    );
  }
  if (preview.kind === "shell") {
    return (
      <div className="tool-body tool-body-pretty" dir={code.dir} style={code.style}>
        <div className="shell-cmd code-font">
          <span className="shell-prompt">$</span> {preview.command}
        </div>
        {preview.output && <pre className="code-font shell-out">{preview.output}</pre>}
      </div>
    );
  }
  if (preview.kind === "search") {
    return (
      <div className="tool-body tool-body-pretty" dir={code.dir} style={code.style}>
        <div className="search-meta code-font">
          <span className="search-pat">/{preview.pattern}/</span>
          {preview.path && <span className="search-path">{preview.path}</span>}
        </div>
        {preview.output && <pre className="code-font">{preview.output}</pre>}
      </div>
    );
  }
  if (preview.kind === "text") {
    return (
      <div className="tool-body tool-body-pretty" dir={code.dir} style={code.style}>
        <pre className="code-font">{preview.content}</pre>
      </div>
    );
  }
  if (preview.kind === "questions") {
    return (
      <div className="tool-body tool-body-pretty questions-preview" dir={code.dir} style={code.style}>
        <ul className="q-preview-list">
          {preview.lines.map((line, i) => (
            <li key={i}>
              <pre className="code-font">{line}</pre>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // empty / audit fallback
  if (audit && item.raw != null) {
    return (
      <div className="tool-body" dir={code.dir} style={code.style}>
        <pre className="audit-raw code-font">{JSON.stringify(item.raw, null, 2)}</pre>
      </div>
    );
  }
  return (
    <div className="tool-body tool-body-pretty muted">
      <span className="tool-empty">No preview</span>
    </div>
  );
}

/** Status indicator — color only (no "completed"/"failed" text). */
function StatusDot({ status }: { status?: string | null }) {
  const s = (status || "").toLowerCase();
  let kind = "pending";
  if (s === "completed" || s === "success") kind = "ok";
  else if (s === "failed" || s === "error") kind = "err";
  else if (s === "in_progress" || s === "running" || s === "pending") kind = "run";
  else if (s === "cancelled" || s === "canceled") kind = "cancel";
  else if (!s) kind = "idle";
  return (
    <span
      className={`status-dot status-dot--${kind}`}
      title={status || undefined}
      aria-label={status || "status"}
      data-status={status || ""}
    />
  );
}

function SingleTool({
  item,
  audit,
  defaultOpen,
  isHistory,
}: {
  item: StreamItem;
  audit?: boolean;
  defaultOpen?: boolean;
  isHistory?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen) && !isHistory);
  const label = toolShortLabel(item);
  const isAsk =
    /ask\s+\d+\s+questions?|ask_user_question/i.test(item.title || "") ||
    /ask_user_question/i.test(String(item.toolName || ""));
  return (
    <div className={`tl-tool ${isHistory ? "" : "anim-in"}`.trim()}>
      <button
        type="button"
        className={`tool-chip ${isAsk ? "ask" : ""}`}
        onClick={() => {
          // Re-open question modal if this is a stuck ask_user_question tool
          if (isAsk && typeof window !== "undefined" && window.grokDesktop) {
            try {
              const store = (
                window as unknown as {
                  __grokReopenQuestions?: (item: StreamItem) => void;
                }
              ).__grokReopenQuestions;
              store?.(item);
            } catch {
              // ignore
            }
          }
          setOpen((v) => !v);
        }}
      >
        <StatusDot status={item.status} />
        <span className="tool-chip-text">{label}</span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <ToolBody item={item} audit={audit} />}
    </div>
  );
}

function ToolGroupView({
  entry,
  audit,
  isHistory,
}: {
  entry: Extract<TimelineEntry, { type: "tool_group" }>;
  audit?: boolean;
  isHistory?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tl-tool-group ${isHistory ? "" : "anim-in"}`.trim()}>
      <button type="button" className="tool-chip group" onClick={() => setOpen((v) => !v)}>
        <StatusDot status={entry.status} />
        <span className="tool-chip-text">{entry.label}</span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-group-list flat">
          {entry.items.map((it) => (
            <SingleTool
              key={it.id}
              item={it}
              audit={audit}
              defaultOpen={false}
              isHistory={isHistory}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThoughtGroup({ text, isHistory }: { text: string; isHistory?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().replace(/\s+/g, " ").slice(0, 72);
  return (
    <div className={`tl-thought ${isHistory ? "" : "anim-in"}`.trim()}>
      <button type="button" className="thought-chip" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span>Thinking</span>
        {!open && preview && (
          <span className="thought-preview">
            · {preview}
            {text.length > 72 ? "…" : ""}
          </span>
        )}
      </button>
      {open && <div className="thought-body">{text}</div>}
    </div>
  );
}

function PlanBlock({
  text,
  defaultOpen,
  isHistory,
}: {
  text: string;
  defaultOpen?: boolean;
  isHistory?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen) && !isHistory);
  return (
    <div className={`tl-plan ${isHistory ? "" : "anim-in"}`.trim()}>
      <button type="button" className="tool-chip plan" onClick={() => setOpen((v) => !v)}>
        <Diamond />
        <span>Plan</span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="msg-bubble agent plan-body">
          <Md>{text}</Md>
        </div>
      )}
    </div>
  );
}

export function TimelineEntryView({
  entry,
  mode = "clean",
  audit,
  isHistory,
}: {
  entry: TimelineEntry;
  mode?: Mode;
  audit?: boolean;
  /** History batch — no enter animations (prevents "messages pouring in" freeze). */
  isHistory?: boolean;
}) {
  const wrap = (node: ReactNode) =>
    isHistory ? <div className="hist-item">{node}</div> : node;

  if (entry.type === "tool_group") {
    return wrap(
      <ToolGroupView entry={entry} audit={audit || mode === "audit"} isHistory />,
    );
  }
  if (entry.type === "thought_group") {
    return wrap(<ThoughtGroup text={entry.text} isHistory />);
  }
  return wrap(
    <StreamItemView item={entry.item} mode={mode} audit={audit} isHistory />,
  );
}

export function StreamItemView({
  item,
  audit,
  mode = "clean",
  isHistory,
}: {
  item: StreamItem;
  audit?: boolean;
  mode?: Mode;
  isHistory?: boolean;
}): ReactNode {
  const anim = isHistory ? "" : "anim-in";

  if (item.kind === "user") {
    // Defense in depth: strip any leftover system-reminders at render time
    const parsed = parseMessageContent(item.text || "", {
      hideSystem: true,
      keepSystemChips: false,
    });
    const images = [
      ...(item.images || []),
      ...parsed.images.map((im) => ({
        label: im.label,
        index: im.index,
        path: im.path,
        dataUrl: im.dataUrl,
      })),
    ];
    // Deduplicate by path/dataUrl/label
    const seen = new Set<string>();
    const uniqueImages = images.filter((im) => {
      const k = im.dataUrl || im.path || im.label;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!parsed.text.trim() && uniqueImages.length === 0) {
      return null;
    }

    const dir = detectTextDirection(parsed.text || "");
    const dirClass = dir === "rtl" ? "is-rtl" : dir === "ltr" ? "is-ltr" : "is-auto";

    return (
      <div
        className={`msg msg-user ${dirClass} ${anim}`.trim()}
        data-kind="user"
        data-dir={dir}
        data-item-id={item.id}
      >
        <div className="msg-label">
          <span>You</span>
          <span className="msg-actions">
            <button
              type="button"
              className="msg-action-btn"
              title="Rewind to this message (restore files + drop later turns)"
              onClick={() =>
                (
                  window as unknown as {
                    __grokRewindToItem?: (id: string) => void;
                  }
                ).__grokRewindToItem?.(item.id)
              }
            >
              Rewind
            </button>
            <button
              type="button"
              className="msg-action-btn"
              title="Fork a new chat from this state"
              onClick={() =>
                (
                  window as unknown as {
                    __grokForkFromItem?: (id: string) => void;
                  }
                ).__grokForkFromItem?.(item.id)
              }
            >
              Fork
            </button>
          </span>
        </div>
        {uniqueImages.length > 0 && <ImageGallery images={uniqueImages} />}
        {parsed.text.trim() ? (
          <div
            className="msg-bubble user"
            dir={dir === "auto" ? undefined : dir}
          >
            <Md>{parsed.text}</Md>
          </div>
        ) : null}
      </div>
    );
  }

  if (item.kind === "agent_text") {
    const text = item.text || "";
    const dir = detectTextDirection(text);
    const dirClass = dir === "rtl" ? "is-rtl" : dir === "ltr" ? "is-ltr" : "is-auto";
    return (
      <div
        className={`msg msg-agent ${dirClass} ${anim}`.trim()}
        data-kind="agent_text"
        data-dir={dir}
      >
        <div className="msg-label">
          <span className="grok-dot" /> Grok
        </div>
        <div
          className="msg-bubble agent"
          dir={dir === "auto" ? undefined : dir}
        >
          <Md>{text}</Md>
        </div>
      </div>
    );
  }

  if (item.kind === "thought") {
    return <ThoughtGroup text={item.text || ""} isHistory={isHistory} />;
  }

  if (item.kind === "plan") {
    return (
      <PlanBlock
        text={item.text || ""}
        defaultOpen={mode !== "clean"}
        isHistory={isHistory}
      />
    );
  }

  if (item.kind === "tool_call" || item.kind === "tool_result") {
    return (
      <SingleTool
        item={item}
        audit={audit || mode === "audit"}
        defaultOpen={mode === "transparent" && !isHistory}
        isHistory={isHistory}
      />
    );
  }

  if (item.kind === "error" || item.kind === "permission") {
    return (
      <div className={`msg ${anim}`.trim()} data-kind={item.kind}>
        <div className="msg-bubble error">
          <strong>{item.kind === "permission" ? "Permission" : "Error"}</strong>
          <div>{item.text || item.title}</div>
        </div>
      </div>
    );
  }

  if (!item.text?.trim() && !item.title) return null;
  return (
    <div className={`msg ${anim}`.trim()}>
      <div className="msg-bubble thought">{item.text || item.title}</div>
    </div>
  );
}
