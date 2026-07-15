import { useEffect, useRef } from "react";
import type { PermissionRequest } from "@shared/types";

type Props = {
  permission: PermissionRequest;
  onRespond: (allow: boolean, optionId?: string) => void;
};

export function PermissionModal({ permission, onRespond }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onRespond(false, "reject-once");
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const allow = permission.options.find(
          (o) => !/reject|deny|cancel/i.test(o.kind + o.name + o.optionId),
        );
        onRespond(true, allow?.optionId || "allow-once");
      } else if (e.key === "a" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onRespond(true, "allow-once");
      } else if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onRespond(false, "reject-once");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [permission, onRespond]);

  const options =
    permission.options?.length > 0
      ? permission.options
      : [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ];

  return (
    <div
      className="modal-backdrop permission-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Permission request"
      data-testid="permission-modal"
    >
      <div className="modal permission-modal">
        <header>Permission required</header>
        <div className="body ltr-isolate" dir="ltr">
          <strong style={{ color: "var(--text)" }}>{permission.title}</strong>
          <div className="permission-desc" style={{ marginTop: "0.75rem" }}>
            {permission.description}
          </div>
          <div className="permission-hint">
            Press <kbd>A</kbd> allow · <kbd>D</kbd> deny · <kbd>Esc</kbd> deny
          </div>
        </div>
        <footer>
          {options.map((opt, i) => {
            const allow = !/reject|deny|cancel/i.test(
              opt.kind + opt.name + opt.optionId,
            );
            return (
              <button
                key={opt.optionId}
                ref={allow && i === 0 ? primaryRef : undefined}
                className={allow ? "primary" : "danger"}
                onClick={() => onRespond(allow, opt.optionId)}
              >
                {opt.name}
              </button>
            );
          })}
        </footer>
      </div>
    </div>
  );
}
