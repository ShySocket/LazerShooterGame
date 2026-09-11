import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPwa } from './pwa';
import { installDiagnostics } from './diag';
import { ErrorBoundary } from './ErrorBoundary';
import App from './App';
import { Bench } from './bench/Bench';
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
