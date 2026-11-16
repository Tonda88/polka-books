import { useEffect, useState } from 'react';
import { getBook } from '../data/books';
import type { BookMeta, Bookmark, DownloadMeta } from '../types';
import { useApp } from '../lib/store';
import { navigate, openReader } from '../lib/router';
import { humanBytes, plural, shortText, timeAgo } from '../lib/format';
import { BookCover } from '../components/Cover';
import { BookRow } from '../components/BookRow';
import { Icon } from '../components/Icons';

type Tab = 'reading' | 'downloads' | 'finished' | 'bookmarks';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'reading', label: 'Читаю' },
  { id: 'downloads', label: 'Скачанные' },
  { id: 'finished', label: 'Готово' },
  { id: 'bookmarks', label: 'Закладки' },
];

export function LibraryScreen() {
  const { state, removeDownload, removeBookmark } = useApp();
  const [tab, setTab] = useState<Tab>('reading');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);

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

  const reading = Object.values(state.progress)
    .filter((entry) => !entry.finishedAt && entry.percent > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((entry) => getBook(entry.bookId))
    .filter((book): book is BookMeta => Boolean(book));

  const finished = Object.values(state.progress)
    .filter((entry) => entry.finishedAt)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .map((entry) => getBook(entry.bookId))
    .filter((book): book is BookMeta => Boolean(book));

  const downloads = Object.values(state.downloads)
    .sort((a, b) => b.at - a.at)
    .map((meta: DownloadMeta) => ({ meta, book: getBook(meta.bookId) }))
    .filter((item): item is { meta: DownloadMeta; book: BookMeta } => Boolean(item.book));

  const totalBytes = downloads.reduce((sum, item) => sum + item.meta.bytes, 0);

  const bookmarks = [...state.bookmarks].sort((a, b) => b.at - a.at);

  const counts: Record<Tab, number> = {
    reading: reading.length,
    downloads: downloads.length,
    finished: finished.length,
    bookmarks: bookmarkCount(state.bookmarks),
  };

  const handleDelete = async (bookId: string) => {
    if (confirmDeleteId !== bookId) {
      setConfirmDeleteId(bookId);
      window.setTimeout(() => setConfirmDeleteId(null), 3200);
      return;
    }
    await removeDownload(bookId);
    setConfirmDeleteId(null);
  };

  return (
    <div className="screen library">
      <header className="page-head">
        <h1 className="page-title">Моя полка</h1>
        <p className="page-sub">
          {reading.length > 0
            ? `${reading.length} ${plural(reading.length, 'книга', 'книги', 'книг')} в процессе чтения`
            : 'Здесь появятся ваши книги и закладки'}
        </p>
      </header>

      <div className="offline-status">
        <span className={`status-dot ${online ? 'is-online' : 'is-offline'}`} />
        {online ? (
          <span>Интернет есть · скачанные книги читаются без сети</span>
        ) : (
          <span>Офлайн-режим · доступны {downloads.length} {plural(downloads.length, 'книга', 'книги', 'книг')}</span>
        )}
      </div>

      <div className="segmented library-tabs">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`segmented__item ${tab === item.id ? 'is-active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {counts[item.id] > 0 && <span className="segmented__count">{counts[item.id]}</span>}
          </button>
        ))}
      </div>

      {tab === 'reading' && (
        <div className="tab-panel">
          {reading.length > 0 ? (
            <div className="list">
              {reading.map((book) => (
                <BookRow key={book.id} book={book} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon="book"
              title="Пока ничего не читаете"
              text="Выберите книгу в каталоге — прогресс сохранится автоматически, даже офлайн."
              actionLabel="Открыть каталог"
              onAction={() => navigate('/catalog')}
            />
          )}
        </div>
      )}

      {tab === 'downloads' && (
        <div className="tab-panel">
          <div className="storage-card">
            <div className="storage-card__ring">
              <Icon name="download" size={22} />
            </div>
            <div className="storage-card__body">
              <strong>
                {downloads.length} {plural(downloads.length, 'книга', 'книги', 'книг')} офлайн
              </strong>
              <span>{humanBytes(totalBytes)} · текст и аудио на устройстве</span>
            </div>
            <button type="button" className="mini-button" onClick={() => navigate('/catalog')}>
              Ещё
            </button>
          </div>
          {downloads.length > 0 ? (
            <div className="download-list">
              {downloads.map(({ book, meta }) => (
                <div className="download-item" key={book.id}>
                  <button type="button" className="download-item__main" onClick={() => openReader(book.id)}>
                    <BookCover book={book} size="xs" />
                    <span className="download-item__info">
                      <span className="download-item__title">{book.title}</span>
                      <span className="download-item__meta">
                        {book.author} · {humanBytes(meta.bytes)} · {timeAgo(meta.at)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`download-item__delete ${confirmDeleteId === book.id ? 'is-danger' : ''}`}
                    onClick={() => void handleDelete(book.id)}
                    aria-label={`Удалить скачанную книгу «${book.title}»`}
                  >
                    {confirmDeleteId === book.id ? 'Удалить?' : <Icon name="trash" size={17} />}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="download"
              title="Нет скачанных книг"
              text="Скачайте книгу — текст и аудио останутся на устройстве. Открывайте в метро, поезде и самолёте."
              actionLabel="Выбрать книгу"
              onAction={() => navigate('/catalog')}
            />
          )}
        </div>
      )}

      {tab === 'finished' && (
        <div className="tab-panel">
          {finished.length > 0 ? (
            <>
              <p className="tab-note">
                {finished.length} {plural(finished.length, 'книга', 'книги', 'книг')} прочитано. Из них{' '}
                {state.bookmarks.length} {plural(state.bookmarks.length, 'закладка', 'закладки', 'закладок')}.
              </p>
              <div className="list">
                {finished.map((book) => (
                  <BookRow key={book.id} book={book} />
                ))}
              </div>
            </>
          ) : (
            <EmptyState
              icon="check"
              title="Ещё нет прочитанных книг"
              text="Дочитайте книгу до конца — она появится здесь, а прогресс пойдёт в цели."
              actionLabel="Продолжить чтение"
              onAction={() => navigate('/')}
            />
          )}
        </div>
      )}

      {tab === 'bookmarks' && (
        <div className="tab-panel">
          {bookmarks.length > 0 ? (
            <div className="bookmark-list">
              {bookmarks.map((bookmark) => (
                <BookmarkCard
                  key={bookmark.id}
                  bookmark={bookmark}
                  onOpen={() => openReader(bookmark.bookId, bookmark.chapter, bookmark.paragraph)}
                  onDelete={() => removeBookmark(bookmark.id)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon="bookmark"
              title="Закладок пока нет"
              text="В читалке нажмите на флажок — и место сохранится здесь вместе с цитатой."
              actionLabel="Читать"
              onAction={() => navigate('/')}
            />
          )}
        </div>
      )}
    </div>
  );
}

function bookmarkCount(bookmarks: Bookmark[]): number {
  return bookmarks.length;
}

function BookmarkCard({
  bookmark,
  onOpen,
  onDelete,
}: {
  bookmark: Bookmark;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const book = getBook(bookmark.bookId);
  if (!book) return null;
  return (
    <article className="bookmark">
      <button type="button" className="bookmark__main" onClick={onOpen}>
        <div className="bookmark__book">
          <BookCover book={book} size="xxs" />
          <span>
            {book.title} · {bookmark.chapterTitle}
          </span>
        </div>
        <blockquote>{shortText(bookmark.text, 160)}</blockquote>
      </button>
      <button type="button" className="bookmark__delete" onClick={onDelete} aria-label="Удалить закладку">
        <Icon name="x" size={16} />
      </button>
    </article>
  );
}

function EmptyState({
  icon,
  title,
  text,
  actionLabel,
  onAction,
}: {
  icon: string;
  title: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={26} />
      </div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__text">{text}</p>
      <button type="button" className="btn btn--ghost" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
