import { registerSW } from 'virtual:pwa-register';

let apply: ((reload?: boolean) => Promise<void>) | null = null;
let pending = false;
const listeners = new Set<() => void>();

/**
 * Service worker updates are never applied on their own: a reload mid-scan or mid-round would throw
 * away in-memory state. The app calls applyPendingUpdate() when the player is idle on the home screen.
 */
export function initPwa(): void {
  apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true;
      listeners.forEach((l) => l());
    },
  });
}

export function updatePending(): boolean {
  return pending;
}

export function onUpdatePending(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function applyPendingUpdate(): void {
  if (!pending || !apply) return;
  pending = false;
  void apply(true);
}
