import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Toast {
  id: number;
  message: string;
  variant: "info" | "danger";
}

type ShowToast = (message: string, variant?: "info" | "danger") => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Transient bottom-sheet notifications. Auto-dismiss after 4s, manual
 *  dismiss on tap; danger variant gets a red accent. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (message, variant = "info") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      window.setTimeout(() => dismiss(id), 4000);
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