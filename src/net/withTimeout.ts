/**
 * A promise that must settle within `ms`. Firebase writes never reject while the phone is offline,
 * they wait; anything a player is waiting on (a hit, an upload) needs a deadline so the screen can
 * say what happened instead of going quiet.
 */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what = 'the request'): Promise<T> {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(tm);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(tm);
        reject(e);
      },
    );
  });
}

export const isTimeout = (e: unknown): boolean => e instanceof TimeoutError || (e instanceof Error && e.name === 'TimeoutError');
