import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './styles-catalog.css';
import './styles-library.css';
import './styles-prefs.css';
import './styles-web.css';
import './styles-discovery.css';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// В APK приложение открывается с file:// — там service worker недоступен,
// а офлайн обеспечивается тем, что все файлы уже лежат внутри APK.
if ('serviceWorker' in navigator && import.meta.env.PROD && window.location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => console.warn('Service worker не зарегистрирован', error));
  });
}
