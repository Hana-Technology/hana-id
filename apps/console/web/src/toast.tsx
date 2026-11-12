// Toasts (the Journear Passport design system's pattern): a transient confirmation of something the member just did
// ("Key created", "Logo removed"). Bottom-right on desktop, at the top on a phone (styles.css), at most 3 at once (a
// fourth drops the oldest), each dismissed after 5 s unless the pointer or the focus is on it; a danger toast stays
// until it is dismissed. Errors the member can act on stay inline (ErrorNote), never in a toast. Text only.
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { IconAlert, IconCheckCircle, IconInfo, IconX } from './icons.tsx';

export type ToastTone = 'success' | 'info' | 'warning' | 'danger';

export interface ToastInput {
  title: string;
  detail?: string | undefined;
  tone?: ToastTone | undefined;
}

interface Toast extends Required<Pick<ToastInput, 'title'>> {
  id: number;
  tone: ToastTone;
  detail?: string | undefined;
}

/** How long a toast stays (the design system's 5 s). */
export const TOAST_MS = 5_000;
/** The most toasts shown at once. */
export const TOAST_MAX = 3;

type Push = (t: ToastInput | string) => void;

// Without a provider (a component rendered on its own), a toast goes nowhere.
const Ctx = createContext<Push>(() => {});

/** Shows a toast: a string is a success title. */
export const useToast = (): Push => useContext(Ctx);

function ToastItem({ t, onClose }: { t: Toast; onClose: (id: number) => void }) {
  const left = useRef(TOAST_MS);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sticky = t.tone === 'danger';
  const stop = useCallback(() => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    left.current -= Date.now() - started.current;
  }, []);
  const go = useCallback(() => {
    if (sticky || timer.current !== undefined) return;
    started.current = Date.now();
    timer.current = setTimeout(() => onClose(t.id), Math.max(left.current, 0));
  }, [sticky, onClose, t.id]);
  useEffect(() => {
    go();
    return () => clearTimeout(timer.current);
  }, [go]);
  const Icon = t.tone === 'success' ? IconCheckCircle : t.tone === 'info' ? IconInfo : IconAlert;
  return (
    <div className={`jp-toast jp-toast-${t.tone}`} role={sticky ? 'alert' : undefined} onMouseEnter={stop} onMouseLeave={go} onFocus={stop} onBlur={go}>
      <Icon className="ic" />
      <div className="tx">
        <b>{t.title}</b>
        {t.detail && <span>{t.detail}</span>}
      </div>
      <button type="button" className="x" aria-label="Dismiss" onClick={() => onClose(t.id)}>
        <IconX />
      </button>
      {!sticky && <span className="bar" aria-hidden="true" />}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback<Push>((input) => {
    const t = typeof input === 'string' ? { title: input } : input;
    const id = next.current++;
    setToasts((all) => [...all, { id, title: t.title, detail: t.detail, tone: t.tone ?? 'success' }].slice(-TOAST_MAX));
  }, []);
  const close = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <section className="toast-region" aria-label="Notifications">
        <div className="jp-toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <ToastItem key={t.id} t={t} onClose={close} />
          ))}
        </div>
      </section>
    </Ctx.Provider>
  );
}
