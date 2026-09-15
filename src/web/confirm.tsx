import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { S } from "./strings";

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** Default true: destructive actions render the danger style. */
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Promise-based replacement for window.confirm(): call useConfirm() and
 *  `await confirm({ title, body })` — resolves true on confirm, false on
 *  cancel or Esc. Enter confirms, Esc cancels. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({ title: "" });
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      else if (e.key === "Enter") settle(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {open && (
        <div className="confirm-overlay" role="alertdialog" aria-modal="true" aria-label={options.title}>
          <div className="confirm-dialog">
            <h3>{options.title}</h3>
            {options.body && <p>{options.body}</p>}
            <div className="confirm-actions">
              <button type="button" className="secondary" onClick={() => settle(false)}>
                {S.confirm.cancel}
              </button>
              <button
                type="button"
                className={options.danger === false ? "" : "danger"}
                onClick={() => settle(true)}
              >
                {options.confirmLabel ?? S.item.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}