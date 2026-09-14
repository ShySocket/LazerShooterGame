import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPwa } from './pwa';
import { installDiagnostics } from './diag';
import { ErrorBoundary } from './ErrorBoundary';
import App from './App';
import { Bench } from './bench/Bench';
import { bodyProportions, FrameSampler, outfitSignature, profileOutfitSim } from './vision/clothing';
import { buildDetections } from './vision/tracker';
import { ReviewDemo } from './feedback/Demo';
import { feedbackStore } from './feedback/store';
import { backend } from './net';

// Development only: lets measurement scripts in the browser console reuse the app's vision helpers,
// and window.__lz reaches the shot-feedback store and backend (local mode keeps uploads in memory).
if (import.meta.env.DEV) {
  (window as unknown as { __lzVision?: unknown }).__lzVision = { bodyProportions, FrameSampler, outfitSignature, profileOutfitSim, buildDetections };
  (window as unknown as { __lz?: unknown }).__lz = { feedbackStore, backend };
}
import './styles.css';

installDiagnostics();
initPwa();

// ?bench opens the tracking bench instead of the game (see src/bench/Bench.tsx).
const params = new URL(location.href).searchParams;
const bench = params.has('bench');
// ?review (dev builds only) opens the shot review card with a synthetic shot, for checking it without a round.
const review = import.meta.env.DEV && params.has('review');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{bench ? <Bench /> : review ? <ReviewDemo /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
