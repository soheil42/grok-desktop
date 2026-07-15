import type { PermissionRequest } from "@shared/types";

type Props = {
  permission: PermissionRequest;
  onRespond: (allow: boolean, optionId?: string) => void;
};

export function PermissionModal({ permission, onRespond }: Props) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Permission request">
      <div className="modal">
        <header>Permission required</header>
        <div className="body ltr-isolate" dir="ltr">
          <strong style={{ color: "var(--text)" }}>{permission.title}</strong>
          <div style={{ marginTop: "0.75rem" }}>{permission.description}</div>
        </div>
        <footer>
          {permission.options.map((opt) => {
            const allow = !/reject|deny|cancel/i.test(opt.kind + opt.name + opt.optionId);
            return (
              <button
                key={opt.optionId}
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
