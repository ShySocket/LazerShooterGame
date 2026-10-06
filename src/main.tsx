import { StrictMode } from 'react';
import { visionProfile } from './vision/frameClock';
import { createRoot } from 'react-dom/client';
import { initPwa } from './pwa';
import { installDiagnostics } from './diag';
import { ErrorBoundary } from './ErrorBoundary';
import App from './App';
import { Bench } from './bench/Bench';
import { bodyProportions, FrameSampler, outfitSignature, profileOutfitSim } from './vision/clothing';
import { buildDetections } from './vision/tracker';
import { ReviewDemo } from './feedback/Demo';
import { Gallery } from './gallery/Gallery';
import { feedbackStore } from './feedback/store';
import { backend } from './net';
import { installE2E, isE2E } from './e2e/hook';
import { installProbe } from './realcheck/probe';

// Development only: lets measurement scripts in the browser console reuse the app's vision helpers
// and the frame profile, and window.__lz reaches the shot-feedback store and backend (local mode
// keeps uploads in memory).
if (import.meta.env.DEV) {
  (window as unknown as { __lzVision?: unknown }).__lzVision = { bodyProportions, FrameSampler, outfitSignature, profileOutfitSim, buildDetections, profile: () => visionProfile.summary(), profileLine: () => visionProfile.line() };
  (window as unknown as { __lz?: unknown }).__lz = { feedbackStore, backend };
  // ?e2e (dev builds only): the browser test harness enrols synthetic profiles and scripts hits.
  if (isE2E()) installE2E(backend);
  // ?realcheck (dev builds only): scripts/realcheck.mjs runs the real models on fixture photos and clips.
  if (new URL(location.href).searchParams.has('realcheck')) installProbe();
}
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';

installDiagnostics();
initPwa();

// ?bench opens the tracking bench instead of the game (see src/bench/Bench.tsx).
const params = new URL(location.href).searchParams;
const bench = params.has('bench');
// ?review (dev builds only) opens the shot review card with a synthetic shot, for checking it without a round.
const review = import.meta.env.DEV && params.has('review');
// ?realcheck (dev builds only) is driven by scripts/realcheck.ts: the app stays unmounted so its own model loader never touches the probe's models.
const realcheck = import.meta.env.DEV && params.has('realcheck');
// ?gallery=<state> (dev builds only): screens the UI tour cannot reach in a round (src/gallery/Gallery.tsx).
const gallery = import.meta.env.DEV ? params.get('gallery') : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{realcheck ? null : bench ? <Bench /> : review ? <ReviewDemo /> : gallery ? <Gallery state={gallery} /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
