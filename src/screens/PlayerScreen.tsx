import { useEffect, useRef, useState } from 'react';
import { getBook, BOOKS } from '../data/books';
import { useApp } from '../lib/store';
import { usePlayer } from '../lib/player';
import { navigate, openBook } from '../lib/router';
import { formatMinutes, formatSeconds } from '../lib/format';
import { BookCover } from '../components/Cover';
import { Icon } from '../components/Icons';

const RATES = [0.8, 1, 1.2, 1.5, 2];

export function PlayerScreen({ bookId }: { bookId?: string }) {
  const player = usePlayer();
  const { state, pushToast } = useApp();
  const snapshot = player.snapshot;
  const book = getBook(snapshot?.bookId ?? bookId);
  const openedRef = useRef<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!bookId) return;
    if (player.snapshot?.bookId === bookId) {
      openedRef.current = bookId;
      return;
    }
    if (openedRef.current === bookId) return;
    openedRef.current = bookId;
    void player.open(bookId, undefined, true).catch(() => {
      /* ошибка показывается из контекста */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, retryKey]);

  if (!book) {
    return (
      <div className="player-screen player-screen--empty">
        <header className="player-bar">
          <button type="button" className="icon-button" onClick={() => navigate('/')} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="player-bar__title">Аудиокнига</span>
          <span className="player-bar__spacer" />
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="headphones" size={26} />
          </div>
          <h2 className="empty__title">Аудиокнига не выбрана</h2>
          <p className="empty__text">Откройте книгу и нажмите «Слушать» — продолжим с сохранённого места.</p>
          <button type="button" className="btn btn--ghost" onClick={() => navigate('/')}>
            На главную
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot && player.loading) {
    return (
      <div className="player-screen player-screen--empty">
        <header className="player-bar">
          <button type="button" className="icon-button" onClick={() => navigate(`/book/${book.id}`)} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="player-bar__title">{book.title}</span>
          <span className="player-bar__spacer" />
        </header>
        <div className="player-loading">
          <div className="spinner" />
          <p>Готовим аудиоверсию…</p>
        </div>
      </div>
    );
  }

  if (!snapshot && !player.error) {
    return (
      <div className="player-screen player-screen--empty">
        <header className="player-bar">
          <button type="button" className="icon-button" onClick={() => navigate(`/book/${book.id}`)} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="player-bar__title">Аудиокнига</span>
          <span className="player-bar__spacer" />
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="headphones" size={26} />
          </div>
          <h2 className="empty__title">Плеер закрыт</h2>
          <p className="empty__text">Продолжите слушать книгу — позиция сохранена.</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              openedRef.current = null;
              setRetryKey((value) => value + 1);
            }}
          >
            Включить снова
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/book/${book.id}`)}>
            К книге
          </button>
        </div>
      </div>
    );
  }

  if (player.error) {
    return (
      <div className="player-screen player-screen--empty">
        <header className="player-bar">
          <button type="button" className="icon-button" onClick={() => navigate(`/book/${book.id}`)} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
          <span className="player-bar__title">Аудиокнига</span>
          <span className="player-bar__spacer" />
        </header>
        <div className="empty">
          <div className="empty__icon">
            <Icon name="wifiOff" size={26} />
          </div>
          <h2 className="empty__title">Не удалось включить аудио</h2>
          <p className="empty__text">{player.error}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              openedRef.current = null;
              setRetryKey((value) => value + 1);
            }}
          >
            Попробовать снова
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => navigate(`/book/${book.id}`)}>
            Скачать книгу
          </button>
        </div>
      </div>
    );
  }

  if (!snapshot) return null;

  const narrator = book.narrator;
  const currentParagraph = player.current?.text ?? '';
  const remainingMinutes = (book.minutes * (100 - snapshot.percent)) / 100;
  const sleepMinutes = snapshot.sleepAt ? Math.max(0, Math.ceil((snapshot.sleepAt - Date.now()) / 60_000)) : null;
  const chapterTitle = player.content?.chapters[snapshot.chapter]?.title ?? 'Глава';

  const openText = () => {
    navigate(`/read/${book.id}/${snapshot.chapter}/${snapshot.paragraph}`);
  };

  return (
    <div className="player-screen">
      <header className="player-bar">
        <button type="button" className="icon-button" onClick={() => navigate(`/book/${book.id}`)} aria-label="Назад к книге">
          <Icon name="left" size={22} />
        </button>
        <div className="player-bar__center">
          <span className="player-bar__title">Аудиокнига</span>
          <span className="player-bar__sub">
            {snapshot.engine === 'sim' ? 'демо-озвучка · текст подсвечивается' : 'синтез речи · русский голос'}
          </span>
        </div>
        <button type="button" className="icon-button" onClick={() => player.close()} aria-label="Закрыть плеер">
          <Icon name="x" size={20} />
        </button>
      </header>

      <div className={`player-art ${snapshot.playing ? 'is-playing' : ''}`}>
        <div className="player-art__glow" />
        <BookCover book={book} size="xl" />
      </div>

      <div className="player-meta">
        <h1 className="player-meta__title">{book.title}</h1>
        <p className="player-meta__author">
          {book.author} · читает {narrator}
        </p>
        <div className="player-meta__chapter">
          <Icon name="headphones" size={15} />
          {chapterTitle}
        </div>
      </div>

      <div className="player-quote">
        <p>{currentParagraph}</p>
      </div>

      <div className="player-progress">
        <input
          className="range range--player"
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={Math.max(0, Math.min(100, snapshot.percent))}
          onChange={(event) => player.seekPercent(Number(event.target.value))}
          aria-label="Позиция в книге"
        />
        <div className="player-time">
          <span>{formatSeconds(snapshot.elapsedSec)}</span>
          <span>−{formatMinutes(remainingMinutes)}</span>
        </div>
      </div>

      <div className="player-controls">
        <button type="button" className="player-skip" onClick={player.prev} aria-label="Предыдущий абзац">
          <Icon name="skipBack" size={26} />
        </button>
        <button type="button" className="player-play" onClick={player.toggle} aria-label={snapshot.playing ? 'Пауза' : 'Слушать'}>
          <Icon name={snapshot.playing ? 'pause' : 'play'} size={32} />
        </button>
        <button type="button" className="player-skip" onClick={player.next} aria-label="Следующий абзац">
          <Icon name="skipForward" size={26} />
        </button>
      </div>

      <div className="player-rates">
        {RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            className={`chip ${Math.abs(snapshot.rate - rate) < 0.01 ? 'is-active' : ''}`}
            onClick={() => player.setRate(rate)}
          >
            ×{rate}
          </button>
        ))}
      </div>

      <div className="player-tools">
        <button type="button" className="player-tool" onClick={openText}>
          <Icon name="book" size={19} />
          <span>Открыть текст</span>
        </button>
        <button
          type="button"
          className={`player-tool ${sleepMinutes !== null ? 'is-active' : ''}`}
          onClick={() => player.setSleep(sleepMinutes !== null ? null : 30)}
        >
          <Icon name="timer" size={19} />
          <span>{sleepMinutes !== null ? `Сон · ${sleepMinutes} мин` : 'Таймер сна'}</span>
        </button>
        <button
          type="button"
          className="player-tool"
          onClick={() => {
            if (!player.voiceAvailable) {
              pushToast('В браузере нет русских голосов — включена демо-озвучка с подсветкой', 'info');
              return;
            }
            const voices = player.voices;
            const index = voices.findIndex((voice) => voice.name === state.settings.ttsVoice);
            const next = voices[(index + 1) % voices.length];
            player.setVoice(next.name);
            pushToast(`Голос: ${next.name}`, 'info');
          }}
        >
          <Icon name="volume" size={19} />
          <span>{state.settings.ttsVoice ? 'Сменить голос' : 'Голос'}</span>
        </button>
      </div>

      {snapshot.engine === 'sim' && (
        <div className="player-notice">
          <Icon name="sparkles" size={16} />
          Демо-режим: браузер не дал русский голос. Текст подсвечивается в темпе чтения, позиция сохраняется так же,
          как с настоящей озвучкой.
        </div>
      )}

      <button type="button" className="player-sync" onClick={openText}>
        <span className="player-sync__icon">
          <Icon name="book" size={18} />
        </span>
        <span>
          <strong>Позиция общая с текстом</strong>
          <span>Читалка откроется ровно на этом абзаце — и наоборот</span>
        </span>
        <Icon name="right" size={17} className="muted" />
      </button>

      <div className="player-related">
        <span className="player-related__label">Послушать ещё</span>
        <div className="h-scroll h-scroll--compact">
          {BOOKS.filter((item) => item.id !== book.id)
            .slice(0, 5)
            .map((item) => (
              <button key={item.id} type="button" className="player-related__item" onClick={() => openBook(item.id)}>
                <BookCover book={item} size="xxs" />
                <span>
                  <strong>{item.title}</strong>
                  <span>{item.author}</span>
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
