import { useEffect, useState } from 'react';
import { BOOKS, GENRES } from '../data/books';
import { useApp } from '../lib/store';
import { usePlayer } from '../lib/player';
import { favoriteGenres } from '../lib/recommend';
import { bestStreak, currentStreak, totalStats } from '../lib/goals';
import { formatMinutes, formatNumber, humanBytes, initials } from '../lib/format';
import { navigate, openPreferences } from '../lib/router';
import { checkSources } from '../catalog/registry';
import type { SourceHealth } from '../catalog/types';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';

const THEMES = [
  { id: 'dark' as const, label: 'Тёмная' },
  { id: 'sepia' as const, label: 'Сепия' },
  { id: 'light' as const, label: 'Светлая' },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

export function ProfileScreen() {
  const { state, updateProfile, updateSettings, seedDemo, resetAll, pushToast } = useApp();
  const player = usePlayer();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(state.profile.name);
  const [installOpen, setInstallOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [keyDraft, setKeyDraft] = useState(state.settings.googleBooksKey ?? '');
  const [sourcesHealth, setSourcesHealth] = useState<Record<string, SourceHealth> | null>(null);
  const [checkingSources, setCheckingSources] = useState(false);

  const checkSourcesNow = async () => {
    if (checkingSources) return;
    setCheckingSources(true);
    try {
      const health = await checkSources();
      setSourcesHealth(health);
      const ok = Object.values(health).filter((item) => item.ok).length;
      pushToast(`Источники: доступно ${ok} из ${Object.keys(health).length}`, ok > 0 ? 'success' : 'error');
    } finally {
      setCheckingSources(false);
    }
  };

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const stats = totalStats(state);
  const streak = currentStreak(state.sessions);
  const best = bestStreak(state.sessions);
  const taste = favoriteGenres(state);
  const downloads = Object.values(state.downloads);
  const storageBytes = downloads.reduce((sum, item) => sum + item.bytes, 0);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as unknown as { standalone?: boolean }).standalone);

  const saveName = () => {
    updateProfile({ name: nameDraft.trim() || state.profile.name });
    setEditingName(false);
    pushToast('Имя сохранено');
  };

  const toggleInterest = (genre: string) => {
    const has = state.profile.interests.includes(genre);
    updateProfile({
      interests: has
        ? state.profile.interests.filter((item) => item !== genre)
        : [...state.profile.interests, genre],
    });
  };

  const reset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      window.setTimeout(() => setConfirmReset(false), 3500);
      return;
    }
    await resetAll();
  };

  return (
    <div className="screen profile">
      <header className="profile-head">
        <div className="profile-avatar">{state.profile.name ? initials(state.profile.name) : 'П'}</div>
        <div className="profile-head__body">
          {editingName ? (
            <form
              className="profile-name-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveName();
              }}
            >
              <input
                className="profile-name-input"
                value={nameDraft}
                autoFocus
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={saveName}
                aria-label="Ваше имя"
                maxLength={40}
              />
            </form>
          ) : (
            <button type="button" className="profile-name" onClick={() => setEditingName(true)}>
              {state.profile.name || 'Читатель'}
              <Icon name="pencil" size={14} className="muted" />
            </button>
          )}
          <div className="profile-sub">
            {taste.length > 0 ? `Любимые жанры: ${taste.join(' · ')}` : 'Вкус ещё формируется'}
          </div>
        </div>
      </header>

      <div className="profile-stats">
        <div className="stat-tile">
          <strong>{stats.finished}</strong>
          <span>прочитано книг</span>
        </div>
        <div className="stat-tile">
          <strong>{formatNumber(stats.pages)}</strong>
          <span>страниц</span>
        </div>
        <div className="stat-tile">
          <strong>{formatMinutes(stats.minutes)}</strong>
          <span>с книгой</span>
        </div>
        <div className="stat-tile">
          <strong>
            {streak}
            <span className="stat-tile__small"> / {best}</span>
          </strong>
          <span>серия / рекорд, дней</span>
        </div>
      </div>

      <section className="settings-card">
        <h2 className="settings-card__title">Интересы</h2>
        <p className="settings-card__hint">На основе интересов и прочитанного строятся рекомендации.</p>
        <div className="chips-row chips-row--wrap">
          {GENRES.map((genre) => (
            <button
              key={genre}
              type="button"
              className={`chip ${state.profile.interests.includes(genre) ? 'is-active' : ''}`}
              onClick={() => toggleInterest(genre)}
            >
              {genre}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Чтение</h2>
        <div className="setting-row">
          <span className="setting-row__label">Тема читалки</span>
          <div className="segmented segmented--small">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className={`segmented__item ${state.settings.theme === theme.id ? 'is-active' : ''}`}
                onClick={() => updateSettings({ theme: theme.id })}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row setting-row--column">
          <div className="setting-row__top">
            <span className="setting-row__label">Размер шрифта</span>
            <span className="setting-row__value">{Math.round(state.settings.fontScale * 100)}%</span>
          </div>
          <input
            className="range"
            type="range"
            min={0.86}
            max={1.34}
            step={0.02}
            value={state.settings.fontScale}
            onChange={(event) => updateSettings({ fontScale: Number(event.target.value) })}
            aria-label="Размер шрифта"
          />
        </div>
        <div className="setting-row">
          <span className="setting-row__label">Шрифт с засечками</span>
          <Switch checked={state.settings.serif} onChange={(value) => updateSettings({ serif: value })} label="Шрифт с засечками" />
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Аудио</h2>
        <div className="setting-row setting-row--column">
          <div className="setting-row__top">
            <span className="setting-row__label">Скорость озвучки</span>
            <span className="setting-row__value">×{state.settings.ttsRate.toFixed(1)}</span>
          </div>
          <input
            className="range"
            type="range"
            min={0.8}
            max={1.8}
            step={0.1}
            value={state.settings.ttsRate}
            onChange={(event) => player.setRate(Number(event.target.value))}
            aria-label="Скорость озвучки"
          />
        </div>
        <div className="setting-row setting-row--column">
          <div className="setting-row__top">
            <span className="setting-row__label">Голос</span>
            <span className="setting-row__value">{player.voices.length > 0 ? `${player.voices.length} русских голосов` : 'системный'}</span>
          </div>
          <select
            className="select"
            value={state.settings.ttsVoice ?? ''}
            onChange={(event) => player.setVoice(event.target.value || null)}
            aria-label="Голос озвучки"
          >
            <option value="">Автоматически</option>
            {player.voices.map((voice) => (
              <option key={voice.name} value={voice.name}>
                {voice.name}
              </option>
            ))}
          </select>
          {player.voices.length === 0 && (
            <p className="settings-card__hint">
              В этом браузере нет русских голосов. Включится демо-озвучка: текст подсвечивается в темпе чтения, позиция
              синхронизируется с текстом.
            </p>
          )}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Каталог и источники</h2>
        <p className="settings-card__hint">
          Поиск идёт по нескольким официальным каталогам: Open Library, Internet Archive, Project Gutenberg (через
          архив), LibriVox и встроенной библиотеке. Google Books требует личный API-ключ.
        </p>
        <div className="setting-row setting-row--column">
          <div className="setting-row__top">
            <span className="setting-row__label">Ключ Google Books API</span>
            <span className="setting-row__value">{state.settings.googleBooksKey ? 'сохранён' : 'не задан'}</span>
          </div>
          <div className="key-row">
            <input
              className="text-input key-row__input"
              type="password"
              placeholder="AIza… (необязательно)"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              aria-label="Ключ Google Books API"
            />
            <button
              type="button"
              className="mini-button"
              onClick={() => {
                const value = keyDraft.trim();
                updateSettings({ googleBooksKey: value || null });
                pushToast(value ? 'Ключ Google Books сохранён на устройстве' : 'Ключ Google Books удалён');
              }}
            >
              Сохранить
            </button>
          </div>
          <p className="settings-card__hint">
            Ключ необязателен: без него поиск работает по Open Library, Internet Archive, Gutenberg и LibriVox.
            В Google Cloud Console ограничьте ключ API «Books API» и, для Android, приложением
            <code> ru.polka.books </code> с отпечатком SHA-1 сертификата подписи. Для производственной
            версии ключ лучше держать на сервере: <code>GOOGLE_BOOKS_KEY</code> — тогда он не попадает в приложение.
          </p>
        </div>
        <button type="button" className="setting-button" onClick={() => void checkSourcesNow()}>
          <Icon name="sparkles" size={18} />
          {sourcesHealth ? 'Проверить источники снова' : 'Проверить доступность источников'}
          <Icon name="right" size={16} className="muted" />
        </button>
        {sourcesHealth && (
          <div className="source-health">
            {Object.entries(sourcesHealth).map(([id, health]) => (
              <span key={id} className={`source-health__item ${health.ok ? 'is-ok' : 'is-bad'}`}>
                <span className="status-dot" />
                {id}: {health.ok ? 'доступен' : health.note ?? 'недоступен'}
              </span>
            ))}
          </div>
        )}
        <button type="button" className="setting-button" onClick={() => openPreferences()}>
          <Icon name="sparkles" size={18} />
          Вкус и предпочтения — что запомнила «Полка»
          <Icon name="right" size={16} className="muted" />
        </button>
        <button type="button" className="setting-button" onClick={() => navigate('/downloads')}>
          <Icon name="download" size={18} />
          Загрузки и очередь скачивания
          <Icon name="right" size={16} className="muted" />
        </button>
        <button type="button" className="setting-button" onClick={() => navigate('/my')}>
          <Icon name="library" size={18} />
          Мои книги и история
          <Icon name="right" size={16} className="muted" />
        </button>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Офлайн и устройство</h2>
        <div className="setting-row">
          <span className="setting-row__label">
            <span className={`status-dot ${online ? 'is-online' : 'is-offline'}`} />
            {online ? 'Интернет подключён' : 'Офлайн-режим'}
          </span>
          <span className="setting-row__value">{downloads.length} книг скачано</span>
        </div>
        <div className="storage-line">
          <Icon name="download" size={16} />
          <span>{humanBytes(storageBytes)} занято на устройстве</span>
          <span className="storage-line__bar">
            <span style={{ width: `${Math.min(100, storageBytes / 5000)}%` }} />
          </span>
        </div>
        <button type="button" className="setting-button" onClick={() => setInstallOpen(true)}>
          <Icon name="download" size={18} />
          Как установить на телефон
          <Icon name="right" size={16} className="muted" />
        </button>
        <button type="button" className="setting-button" onClick={() => setSourcesOpen(true)}>
          <Icon name="book" size={18} />
          Источники книг и лицензии
          <Icon name="right" size={16} className="muted" />
        </button>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Демо и данные</h2>
        <p className="settings-card__hint">
          Полные тексты книг загружены из Викитеки (ru.wikisource.org), текст — общественное достояние. Кнопка
          «Скачать» сохраняет книгу в базе приложения (IndexedDB) на этом устройстве. Озвучка — синтез речи браузера.
        </p>
        <button type="button" className="setting-button" onClick={seedDemo}>
          <Icon name="sparkles" size={18} />
          Заполнить демо-данными
          <Icon name="right" size={16} className="muted" />
        </button>
        <button type="button" className={`setting-button ${confirmReset ? 'is-danger' : ''}`} onClick={() => void reset()}>
          <Icon name="trash" size={18} />
          {confirmReset ? 'Нажмите ещё раз, чтобы удалить всё' : 'Сбросить все данные'}
          <Icon name="right" size={16} className="muted" />
        </button>
        <p className="settings-card__hint">Версия 1.0.0 · React + IndexedDB + Service Worker · работает офлайн</p>
      </section>

      <p className="profile-foot">Сделано с любовью к книгам · Полка</p>

      <Sheet
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        title="Источники и лицензии"
        subtitle="Полные тексты из Викитеки — свободной библиотеки Wikimedia Foundation"
        full
      >
        <div className="source-list">
          {BOOKS.map((book) => (
            <div className="source-row" key={book.id}>
              <div>
                <strong>{book.title}</strong>
                <span>
                  {book.author} · {book.words.toLocaleString('ru-RU')} слов
                  {book.source?.edition ? ` · ${book.source.edition}` : ''}
                </span>
              </div>
              {book.source && (
                <a href={book.source.url} target="_blank" rel="noreferrer" aria-label={`Источник «${book.title}»`}>
                  Викитека ↗
                </a>
              )}
            </div>
          ))}
        </div>
        <p className="install-guide__note">
          Тексты произведений находятся в общественном достоянии. Страницы Викитеки распространяются на условиях
          CC BY-SA; приложение сохраняет скачанные книги в IndexedDB на устройстве и не передаёт их третьим лицам.
        </p>
      </Sheet>

      <Sheet open={installOpen} onClose={() => setInstallOpen(false)} title="Установка на телефон" subtitle="Приложение работает как PWA">
        <div className="install-guide">
          {standalone ? (
            <p className="install-guide__ok">
              <Icon name="check" size={18} /> Приложение уже запущено как отдельное — отлично!
            </p>
          ) : (
            <>
              <div className="install-guide__block">
                <strong>Android / Chrome</strong>
                <ol>
                  <li>Откройте сайт приложения в Chrome.</li>
                  <li>Нажмите ⋮ в правом верхнем углу.</li>
                  <li>Выберите «Установить приложение» или «Добавить на главный экран».</li>
                </ol>
              </div>
              <div className="install-guide__block">
                <strong>iPhone / Safari</strong>
                <ol>
                  <li>Откройте сайт в Safari.</li>
                  <li>Нажмите «Поделиться» (квадрат со стрелкой).</li>
                  <li>Выберите «На экран „Домой“» и подтвердите.</li>
                </ol>
              </div>
            </>
          )}
          <p className="install-guide__note">
            Приложение установится как обычное, откроется на весь экран, а скачанные книги будут читаться без
            интернета.
          </p>
        </div>
      </Sheet>
    </div>
  );
}
