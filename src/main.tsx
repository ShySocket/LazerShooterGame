import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initPwa } from './pwa';
import App from './App';
import './styles.css';

initPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
