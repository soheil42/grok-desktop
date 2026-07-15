import { useEffect, useState } from "react";

export type RewindPointRow = {
  prompt_index: number;
  created_at?: string;
  num_file_snapshots?: number;
  has_file_changes?: boolean;
  prompt_preview?: string;
};

type Props = {
  points: RewindPointRow[];
  loading?: boolean;
  onPick: (promptIndex: number) => void;
  onClose: () => void;
};

export function RewindModal({ points, loading, onPick, onClose }: Props) {
  const [selected, setSelected] = useState<number | null>(
    points.length ? points[points.length - 1]?.prompt_index ?? null : null,
  );

  useEffect(() => {
    if (points.length) {
      // Prefer rewinding to earlier turns — last valid target is usually length-2
      const max = Math.max(...points.map((p) => p.prompt_index));
      setSelected(max > 0 ? max - 1 : 0);
    }
  }, [points]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Only points that can be rewound to (not the current leaf alone with no prior)
  const rows = [...points].sort((a, b) => b.prompt_index - a.prompt_index);

  return (
    <div
      className="modal-backdrop permission-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Rewind conversation"
      data-testid="rewind-modal"
    >
      <div className="modal permission-modal rewind-modal">
        <header>Rewind conversation</header>
        <div className="body">
          <p className="rewind-intro">
            Restore files and truncate chat history to a previous user message.
            Changes after that point are discarded (same as CLI <code>/rewind</code>).
          </p>
          {loading ? (
            <p className="muted">Loading rewind points…</p>
          ) : rows.length === 0 ? (
            <p className="muted">No rewind points yet. Send a message first.</p>
          ) : (
            <ul className="rewind-list">
              {rows.map((p) => (
                <li key={p.prompt_index}>
                  <button
                    type="button"
                    className={`rewind-row ${selected === p.prompt_index ? "active" : ""}`}
                    onClick={() => setSelected(p.prompt_index)}
                  >
                    <span className="rewind-idx">#{p.prompt_index}</span>
                    <span className="rewind-preview">
                      {(p.prompt_preview || "(empty)").slice(0, 120)}
                    </span>
                    {p.has_file_changes ? (
                      <span className="rewind-files" title="Has file snapshots">
                        files
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={selected == null || loading}
            onClick={() => selected != null && onPick(selected)}
          >
            Rewind here
          </button>
        </footer>
      </div>
    </div>
  );
}
