/**
 * The service worker's cache for model files (vite.config.ts), plus retired names to sweep. Kept
 * apart from human.ts so tests and the loader can name the cache without loading the models.
 */
export const MODELS_CACHE = 'vision-models-v2';
export const STALE_MODEL_CACHES = ['vision-models'];

/**
 * A load that came back with a required model missing may have been served a bad cached shard:
 * drop the model caches so the next attempt fetches fresh files. Safe to call anywhere; a browser
 * without the Cache API just returns.
 */
export async function clearModelCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  for (const name of [MODELS_CACHE, ...STALE_MODEL_CACHES]) await caches.delete(name).catch(() => false);
}
