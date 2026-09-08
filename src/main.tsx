import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root fehlt im HTML-Dokument.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Service worker registration.
 *
 * Registered after `load` so it never competes with the first paint, and only
 * in production: in dev the worker would cache the module graph Vite is busy
 * hot-reloading.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((error: unknown) => {
        console.warn('[pwa] Service Worker konnte nicht registriert werden:', error);
      });
  });
}
