import { useMemo, useState } from 'react';
import { useApp } from '../lib/store';
import { navigate, openCatalogBook, openMyBooks, openReader } from '../lib/router';
import { formatNumber } from '../lib/format';
import {
  usePreferenceState,
  useRatingHistory,
  useLibraryCategories,
} from '../prefs/usePreferences';
import { clearNegative, clearRating, resetPreferences, setManualPreference } from '../prefs/repository';
import { reactionLabel, type Reaction } from '../prefs/types';
import { normalizeWeight } from '../prefs/engine';
import { Icon } from '../components/Icons';
import { Stars } from '../components/Stars';

const REACTION_BY_STARS: Record<number, Reaction> = { 5: 'love', 4: 'like', 3: 'neutral', 2: 'dislike', 1: 'hate' };

function percent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/**
 * Экран «Вкус и предпочтения»: что приложение запомнило и как это
 * поправить вручную. Все данные — из локальной базы предпочтений.
 */
export function PreferencesScreen() {
  const app = useApp();
  const { state, loading } = usePreferenceState();
  const history = useRatingHistory();
  const categories = useLibraryCategories();
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const prefs = state?.prefs;
  const signals = prefs?.signalCount ?? 0;
  const trained = percent(Math.min(1, signals / 12));

  const topAuthors = useMemo(() => {
    if (!prefs) return [];
    const hidden = new Set(prefs.manualOverrides?.hiddenAuthors ?? []);
    return Object.entries(prefs.authors)
      .map(([key, score]) => ({
        key,
        label: state?.authors.find((author) => author.key === key)?.name ?? key,
        score: normalizeWeight(score),
        hidden: hidden.has(key),
      }))
      .filter((item) => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }, [prefs, state]);

  const topGenres = useMemo(() => {
    if (!prefs) return [];
    const hidden = new Set(prefs.manualOverrides?.hiddenGenres ?? []);
    return [
      ...Object.entries(prefs.categories).map(([key, score]) => ({ key, label: key, score: normalizeWeight(score) })),
      ...Object.entries(prefs.genres).map(([key, score]) => ({ key, label: key, score: normalizeWeight(score) })),
    ]
      .filter((item) => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((item) => ({ ...item, hidden: hidden.has(item.key) }));
  }, [prefs]);

  const topSeries = useMemo(() => {
    if (!prefs) return [];
    return Object.entries(prefs.series)
      .map(([key, score]) => ({ key, label: key, score: normalizeWeight(score) }))
      .filter((item) => item.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [prefs]);

  const negatives = useMemo(() => {
    if (!prefs) return [];
    return [
      ...Object.entries(prefs.negativeAuthors).map(([key, score]) => ({ key, label: key, kind: 'author' as const, score })),
      ...Object.entries(prefs.negativeGenres).map(([key, score]) => ({ key, label: key, kind: 'genre' as const, score })),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [prefs]);

  const toggleHidden = async (kind: 'author' | 'genre', key: string, hidden: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await setManualPreference(kind, key, hidden ? 'unhide' : 'hide');
      app.pushToast(hidden ? 'Снова учитываем в рекомендациях' : 'Скрыто из рекомендаций', 'info');
    } finally {
      setBusy(false);
    }
  };

  const removeNegative = async (kind: 'author' | 'genre', key: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await clearNegative(kind, key);
      app.pushToast('Негатив по этой характеристике сброшен', 'success');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setBusy(true);
    try {
      await resetPreferences();
      app.pushToast('Обучение сброшено — начинаем заново', 'success');
      setConfirmReset(false);
    } finally {
      setBusy(false);
    }
  };

  const openHistoryBook = (bookId: string) => {
    if (bookId.startsWith('local:')) {
      openReader(bookId.replace(/^local:/, ''));
      return;
    }
    if (bookId.includes(':')) {
      openCatalogBook(bookId);
      return;
    }
    openReader(bookId);
  };

  return (
    <div className="screen prefs-screen">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Вкус и предпочтения</h1>
          <p className="page-sub">Что «Полка» запомнила о ваших книгах и как это поправить</p>
        </div>
        <button type="button" className="icon-button" onClick={() => navigate('/')} aria-label="На главную">
          <Icon name="x" size={20} />
        </button>
      </header>

      <section className="pref-card">
        <div className="pref-card__head">
          <h2 className="pref-card__title">Система обучена на {trained}%</h2>
          <span className="muted">{signals} сигналов</span>
        </div>
        <div className="pref-progress" aria-hidden="true">
          <span style={{ width: `${trained}%` }} />
        </div>
        <p className="pref-card__hint">
          {signals < 3
            ? 'Пока мало данных: оцените 2–3 книги или скачайте несколько — подборки станут личными.'
            : 'Учитываются оценки, скачивания, чтение и поиск. Чем больше действий, тем точнее рекомендации.'}
        </p>
        <div className="pref-card__actions">
          <button type="button" className="mini-button" onClick={() => navigate('/search')}>
            Найти книги
          </button>
          <button
            type="button"
            className={`mini-button ${confirmReset ? 'is-danger' : ''}`}
            onClick={() => void handleReset()}
            disabled={busy}
          >
            {confirmReset ? 'Нажмите ещё раз' : 'Сбросить обучение'}
          </button>
        </div>
      </section>

      {!loading && topAuthors.length > 0 && (
        <section className="pref-section">
          <div className="section__head">
            <h2 className="section__title">Ваши авторы</h2>
            <span className="muted">{topAuthors.length}</span>
          </div>
          <div className="pref-chips">
            {topAuthors.map((item) => (
              <span key={item.key} className={`pref-chip ${item.hidden ? 'is-hidden' : ''}`}>
                <button
                  type="button"
                  className="pref-chip__label"
                  onClick={() => void toggleHidden('author', item.key, item.hidden)}
                  aria-pressed={!item.hidden}
                >
                  {item.hidden && <Icon name="x" size={12} />}
                  {item.label}
                  <span className="pref-chip__weight">{percent(item.score)}%</span>
                </button>
              </span>
            ))}
          </div>
          <p className="pref-card__hint">Нажмите на автора, чтобы скрыть или вернуть его в рекомендациях.</p>
        </section>
      )}

      {!loading && topGenres.length > 0 && (
        <section className="pref-section">
          <div className="section__head">
            <h2 className="section__title">Жанры и категории</h2>
          </div>
          <div className="pref-chips">
            {topGenres.map((item) => (
              <span key={item.key} className={`pref-chip ${item.hidden ? 'is-hidden' : ''}`}>
                <button
                  type="button"
                  className="pref-chip__label"
                  onClick={() => void toggleHidden('genre', item.key, item.hidden)}
                  aria-pressed={!item.hidden}
                >
                  {item.label}
                  <span className="pref-chip__weight">{percent(item.score)}%</span>
                </button>
              </span>
            ))}
          </div>
        </section>
      )}

      {!loading && topSeries.length > 0 && (
        <section className="pref-section">
          <div className="section__head">
            <h2 className="section__title">Серии и циклы</h2>
          </div>
          <div className="pref-chips">
            {topSeries.map((item) => (
              <span key={item.key} className="pref-chip is-series">
                <span className="pref-chip__label">
                  {item.label}
                  <span className="pref-chip__weight">{percent(item.score)}%</span>
                </span>
              </span>
            ))}
          </div>
        </section>
      )}

      {!loading && negatives.length > 0 && (
        <section className="pref-section">
          <div className="section__head">
            <h2 className="section__title">Что не понравилось</h2>
          </div>
          <ul className="pref-negatives">
            {negatives.map((item) => (
              <li key={`${item.kind}:${item.key}`}>
                <span>{item.label}</span>
                <button type="button" className="link-button" onClick={() => void removeNegative(item.kind, item.key)}>
                  Забыть
                </button>
              </li>
            ))}
          </ul>
          <p className="pref-card__hint">
            После одной плохой оценки жанр или автор не исчезают — просто реже попадаются. Несколько негативных оценок
            снижают приоритет сильнее.
          </p>
        </section>
      )}

      <section className="pref-section">
        <div className="section__head">
          <h2 className="section__title">Моя библиотека</h2>
          <button type="button" className="link-button" onClick={() => openMyBooks()}>
            Открыть
          </button>
        </div>
        <div className="pref-categories">
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className="pref-category"
              onClick={() => openMyBooks()}
              aria-label={`${category.label}: ${category.count}`}
            >
              <span className="pref-category__count">{formatNumber(category.count)}</span>
              <span className="pref-category__label">{category.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="pref-section">
        <div className="section__head">
          <h2 className="section__title">История оценок</h2>
          <span className="muted">{history.length}</span>
        </div>
        {history.length === 0 ? (
          <p className="pref-card__hint">
            Оценок пока нет. Откройте любую книгу и поставьте звёзды или быструю реакцию — здесь появится история.
          </p>
        ) : (
          <ul className="pref-history">
            {history.slice(0, 10).map((entry) => {
              const last = entry.changes[entry.changes.length - 1];
              const stars = last?.stars ?? 0;
              const reaction = last?.reaction ?? REACTION_BY_STARS[stars] ?? 'neutral';
              return (
                <li key={entry.bookId}>
                  <button type="button" className="pref-history__book" onClick={() => openHistoryBook(entry.bookId)}>
                    <span className="pref-history__title">{entry.title ?? entry.bookId}</span>
                    <span className="pref-history__meta">
                      {formatDate(last?.at ?? Date.now())} · {reactionLabel(reaction)}
                    </span>
                  </button>
                  <span className="pref-history__stars">
                    <Stars value={stars} size={13} />
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    onClick={async () => {
                      await clearRating(entry.bookId);
                      app.pushToast('Оценка сброшена', 'info');
                    }}
                  >
                    Сбросить
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="pref-card__hint">
          История изменений хранится локально — можно передумать и изменить оценку в любой момент.
        </p>
      </section>

      <p className="pref-foot">
        Всё хранится только на этом устройстве. Книги не добавляются в библиотеку автоматически — рекомендации
        показывают варианты, скачиваете вы сами.
      </p>
    </div>
  );
}
