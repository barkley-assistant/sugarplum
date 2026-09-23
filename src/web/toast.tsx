import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ToastAction {
  label: string;
  onSelect: () => void;
}

interface Toast {
  id: number;
  message: string;
  variant: "info" | "danger";
  /** Optional single action button (e.g. the reorder Undo). */
  action?: ToastAction;
  /** Opt-in identity: a toast carrying a key REPLACES the previous toast with
   *  the same key instead of stacking. Used by the reorder snackbar, where
   *  only the latest commit's Undo makes sense. */
  key?: string;
}

type ShowToast = (
  message: string,
  variant?: "info" | "danger",
  action?: ToastAction,
  key?: string,
) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** The stack rule: a keyed toast replaces the same-keyed toast in place, a
 *  keyless toast always appends. Pure, so the rule is unit-tested. */
export function upsertByKey<T extends { id: number; key?: string }>(
  prev: T[],
  next: T,
): T[] {
  return next.key === undefined
    ? [...prev, next]
    : [...prev.filter((t) => t.key !== next.key), next];
}

/** Transient bottom-sheet notifications. Auto-dismiss after 4s (6s when the
 *  toast carries an action, so there is time to read and decide), manual
 *  dismiss on tap; danger variant gets a red accent. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (message, variant = "info", action, key) => {
      const id = nextId.current++;
      setToasts((prev) => upsertByKey(prev, { id, message, variant, action, key }));
      // A replaced toast's own timer fires against an id that no longer
      // exists — `dismiss` filters by id, so it is a no-op.
      window.setTimeout(() => dismiss(id), action ? 6000 : 4000);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.variant === "danger" ? " danger" : ""}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                onDismiss(t.id);
                t.action?.onSelect();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}