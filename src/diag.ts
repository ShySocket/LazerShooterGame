/**
 * Tiny crash diary. Whatever ends a session abnormally (a thrown error, an unhandled rejection, or
 * the phone reloading the page on its own) is written here so the home screen can show it afterwards.
 */
const KEY = 'lz:lastIncident';

export interface Incident {
  t: number;
  kind: 'error' | 'rejection' | 'reload';
  message: string;
}

export function recordIncident(kind: Incident['kind'], message: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ t: Date.now(), kind, message: message.slice(0, 600) } satisfies Incident));
  } catch {
    /* storage unavailable */
  }
}

export function readIncident(): Incident | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Incident) : null;
  } catch {
    return null;
  }
}

export function clearIncident(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

const describe = (e: unknown) => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));

/** Global hooks so errors that escape React are still captured. */
export function installDiagnostics(): void {
  window.addEventListener('error', (ev) => recordIncident('error', ev.error ? describe(ev.error) : ev.message));
  window.addEventListener('unhandledrejection', (ev) => recordIncident('rejection', describe(ev.reason)));
}

/** True when this page load was a reload rather than a fresh navigation. */
export function wasReloaded(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === 'reload';
}
