import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './styles-catalog.css';
import './styles-library.css';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => console.warn('Service worker не зарегистрирован', error));
  });
}
