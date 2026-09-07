/** Round to a fixed number of decimal places. Used wherever signatures are compacted for syncing. */
export function roundTo(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
