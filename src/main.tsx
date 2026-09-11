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

// Der Service Worker wird in `useAppUpdate` registriert — dort, wo auch das
// Erkennen neuer Fassungen sitzt. Zwei Registrierungsstellen wären eine
// Fehlerquelle ohne Gegenwert.
