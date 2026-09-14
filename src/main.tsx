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

// Development only: lets measurement scripts in the browser console reuse the app's vision helpers.
if (import.meta.env.DEV) (window as unknown as { __lzVision?: unknown }).__lzVision = { bodyProportions, FrameSampler, outfitSignature, profileOutfitSim, buildDetections, profile: () => visionProfile.summary(), profileLine: () => visionProfile.line() };
import './styles.css';

installDiagnostics();
initPwa();

// ?bench opens the tracking bench instead of the game (see src/bench/Bench.tsx).
const bench = new URL(location.href).searchParams.has('bench');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>{bench ? <Bench /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
