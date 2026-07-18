import { useEffect, useRef } from "react";
import type { PermissionRequest } from "@shared/types";

type Props = {
  permission: PermissionRequest;
  onRespond: (allow: boolean, optionId?: string) => void;
};

export function PermissionPrompt({ permission, onRespond }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditing = target?.matches("input, textarea, [contenteditable='true']");
      const allowOnce = permission.options.find(
        (o) =>
          !/reject|deny|cancel|always|session/i.test(o.kind + o.name + o.optionId),
      );
      const reject = permission.options.find((o) =>
        /reject|deny|cancel/i.test(o.kind + o.name + o.optionId),
      );
      if (e.key === "Escape") {
        e.preventDefault();
        onRespond(false, reject?.optionId || "reject-once");
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const allow = permission.options.find(
          (o) => !/reject|deny|cancel/i.test(o.kind + o.name + o.optionId),
        );
        onRespond(true, allow?.optionId || "allow-once");
      } else if (e.key === "a" && !isEditing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onRespond(true, allowOnce?.optionId || "allow-once");
      } else if (e.key === "d" && !isEditing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onRespond(false, reject?.optionId || "reject-once");
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
    <section
      className="composer-permission"
      role="region"
      aria-label="Permission request"
      data-testid="permission-prompt"
      dir="ltr"
    >
      <div className="permission-summary">
        <span className="permission-icon" aria-hidden>
          <svg viewBox="0 0 24 24">
            <path d="M12 3 5 6v5c0 4.7 2.8 8 7 10 4.2-2 7-5.3 7-10V6l-7-3Z" />
            <path d="M12 8v4m0 3h.01" />
          </svg>
        </span>
        <div className="permission-copy">
          <span className="permission-eyebrow">Approval required</span>
          <strong>{permission.title}</strong>
          {permission.description && (
            <code className="permission-desc">{permission.description}</code>
          )}
        </div>
      </div>
      <div className="permission-actions">
        {options.map((opt, i) => {
          const signature = `${opt.kind} ${opt.name} ${opt.optionId}`;
          const allow = !/reject|deny|cancel/i.test(signature);
          const always = allow && /always|session/i.test(signature);
          const label = allow ? (always ? "Always allow" : "Allow once") : "Deny";
          return (
            <button
              type="button"
              key={opt.optionId}
              ref={allow && i === 0 ? primaryRef : undefined}
              className={`permission-action ${allow ? (always ? "secondary" : "primary") : "deny"}`}
              title={opt.name}
              onClick={() => onRespond(allow, opt.optionId)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Compatibility for imports in older renderer builds.
export const PermissionModal = PermissionPrompt;
