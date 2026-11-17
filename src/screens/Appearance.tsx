import { useState } from 'react';
import { navigate } from '../lib/router';
import { Icon } from '../components/Icons';
import { AppearanceSettings } from '../components/AppearanceSettings';

/** Экран настроек оформления с live preview. */
export function AppearanceScreen() {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <div className="screen appearance-screen">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Внешний вид</h1>
          <p className="page-sub">Оформите «Полку» так, чтобы было приятно читать каждый день</p>
        </div>
        <button type="button" className="icon-button" onClick={() => navigate('/me')} aria-label="Назад в профиль">
          <Icon name="left" size={20} />
        </button>
      </header>

      <div className="appearance-preview-card" data-card-style="preview">
        <div className="appearance-preview-card__cover">
          <span>П</span>
        </div>
        <div className="appearance-preview-card__text">
          <strong>Предпросмотр темы</strong>
          <span>Лев Толстой · Роман</span>
          <small>Обложка, текст и акцент сразу отражают выбранное оформление</small>
        </div>
      </div>

      <AppearanceSettings />

      <button type="button" className="setting-button" onClick={() => setPreviewOpen((value) => !value)}>
        <Icon name="book" size={18} />
        {previewOpen ? 'Скрыть пример карточки' : 'Показать пример карточки'}
        <Icon name="right" size={16} className="muted" />
      </button>
      {previewOpen && (
        <div className="appearance-live-preview">
          <div className="appearance-live-preview__cover">Анна Каренина</div>
          <div className="appearance-live-preview__body">
            <strong>Анна Каренина</strong>
            <span>Лев Толстой · 1877</span>
            <p>Все счастливые семьи похожи друг на друга…</p>
            <button type="button" className="mini-button mini-button--accent">Читать</button>
          </div>
        </div>
      )}

      <p className="appearance-note">Настройки применяются ко всем экранам и сохраняются на этом устройстве.</p>
    </div>
  );
}
