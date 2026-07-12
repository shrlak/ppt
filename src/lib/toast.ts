// Lightweight pub/sub for transient notifications. A single ToastHost mounted
// once at the app root renders whatever's pushed here, so any component can
// call showToast() without prop-drilling or a notice/error state of its own.
export type ToastKind = 'notice' | 'error' | 'warn';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  notice: 4500,
  warn: 5500,
  error: 7000,
};

export function showToast(message: string, kind: ToastKind = 'notice', durationMs?: number): void {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message }];
  emit();
  const duration = durationMs ?? DEFAULT_DURATION[kind];
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}
