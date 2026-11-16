/**
 * «Загрузки» — активная очередь, ошибки и завершённые задачи,
 * список скачанных книг, объём хранилища и удаление с устройства.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { DownloadStatus, DownloadTask, NetworkBook } from '../downloads/types';
import { FORMAT_LABEL } from '../downloads/types';
import { downloads } from '../downloads/manager';
import { useApp } from '../lib/store';
import { navigate, openAudioBook, openCatalogBook, openReader } from '../lib/router';
import { formatMinutes, humanBytes, pct, plural, timeAgo } from '../lib/format';
import { NetworkCover } from '../components/NetworkCover';
import { ProgressBar } from '../components/Progress';
import { Icon } from '../components/Icons';

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'downloading', 'validating', 'processing'];

const STAGE_LABEL: Record<DownloadStatus, string> = {
  queued: 'В очереди',
  downloading: 'Загрузка',
  validating: 'Проверка файла',
  processing: 'Разбор текста',
  ready: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

let initPromise: Promise<void> | null = null;

function ensureDownloadsReady(): Promise<void> {
  if (!initPromise) {
    initPromise = downloads.init().catch((error: unknown) => {
      console.warn('Не удалось открыть хранилище загрузок', error);
    });
  }
  return initPromise;
}

function isActive(status: DownloadStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function formatLabel(format: string): string {
  const normalized = (format || '').toLowerCase();
  return FORMAT_LABEL[normalized] ?? (normalized ? normalized.toUpperCase() : 'Файл');
}

function networkBookFormat(networkBook: NetworkBook): string {
  if (networkBook.kind === 'audio') return 'Аудио';
  if (networkBook.kind === 'pdf') return 'PDF';
  return formatLabel(networkBook.format);
}

function networkBookMeta(networkBook: NetworkBook): string {
  const parts: string[] = [networkBookFormat(networkBook), humanBytes(networkBook.bytes), timeAgo(networkBook.savedAt)];
  if (networkBook.chapters) parts.push(`${networkBook.chapters} гл.`);
  if (networkBook.kind === 'audio' && networkBook.audioTracks?.length) {
    const seconds = networkBook.audioTracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0);
    if (seconds > 0) parts.push(formatMinutes(seconds / 60));
  }
  return parts.join(' · ');
}

function catalogIdOf(networkBook: NetworkBook): string {
  return networkBook.catalogId ?? `${networkBook.sourceId}:${networkBook.externalId}`;
}

function openLibraryBook(networkBook: NetworkBook): void {
  if (networkBook.kind === 'audio') {
    openAudioBook(catalogIdOf(networkBook));
    return;
  }
  openReader(networkBook.id);
}

export function DownloadsScreen() {
  const { pushToast } = useApp();
  const [version, bump] = useReducer((value: number) => value + 1, 0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usage: number; quota: number } | null>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(() => {
    const sync = () => bump();
    const unsubscribe = downloads.subscribe(sync);
    sync();
    void ensureDownloadsReady().then(sync);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const storage = navigator.storage;
    if (!storage || typeof storage.estimate !== 'function') return;
    let cancelled = false;
    void storage
      .estimate()
      .then((estimate) => {
        if (cancelled) return;
        setStorageInfo({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
      })
      .catch(() => {
        /* оценка хранилища не критична */
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const tasks = downloads.getTasks();
  const library = downloads.getLibrary();

  const activeTasks = tasks.filter((task) => isActive(task.status));
  const doneTasks = tasks.filter((task) => task.status === 'ready' && !dismissed.includes(task.id));
  const failedTasks = tasks.filter(
    (task) => (task.status === 'error' || task.status === 'cancelled') && !dismissed.includes(task.id),
  );
  const finishedCount = tasks.filter(
    (task) => task.status === 'ready' || task.status === 'error' || task.status === 'cancelled',
  ).length;
  const libraryBytes = library.reduce((sum, book) => sum + book.bytes, 0);
  const empty = tasks.length === 0 && library.length === 0;

  const cancelTask = (taskId: string) => {
    downloads.cancel(taskId);
    pushToast('Загрузка отменена');
  };

  const retryTask = (taskId: string) => {
    void downloads
      .retry(taskId)
      .then(() => pushToast('Повторяем загрузку', 'info'))
      .catch(() => pushToast('Не удалось повторить загрузку', 'error'));
  };

  const dismissTask = (taskId: string) => {
    setDismissed((previous) => (previous.includes(taskId) ? previous : [...previous, taskId]));
  };

  const clearFinished = () => {
    downloads.clearFinished();
    setDismissed([]);
    pushToast('Завершённые загрузки убраны из списка');
  };

  const removeLibraryBook = (networkBook: NetworkBook) => {
    if (confirmId !== networkBook.id) {
      setConfirmId(networkBook.id);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => {
        setConfirmId((current) => (current === networkBook.id ? null : current));
        confirmTimer.current = null;
      }, 3200);
      return;
    }
    setConfirmId(null);
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    void downloads
      .remove(networkBook.id)
      .then(() => pushToast('Скачанная книга удалена с устройства'))
      .catch(() => pushToast('Не удалось удалить книгу с устройства', 'error'));
  };

  return (
    <div className="screen downloads">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Загрузки</h1>
          <p className="page-sub">
            {activeTasks.length > 0
              ? `${activeTasks.length} ${plural(activeTasks.length, 'загрузка', 'загрузки', 'загрузок')} в работе`
              : library.length > 0
                ? `${library.length} ${plural(library.length, 'книга', 'книги', 'книг')} офлайн · ${humanBytes(
                    libraryBytes,
                  )}`
                : 'Очередь загрузок и книги на устройстве'}
          </p>
        </div>
        <button
          type="button"
          className="icon-button icon-button--accent"
          onClick={() => navigate('/search')}
          aria-label="Найти книгу"
        >
          <Icon name="search" size={19} />
        </button>
      </header>

      {empty ? (
        <EmptyState
          title="Пока ничего не скачано"
          text="Найдите книгу в каталоге и нажмите «Скачать» — она останется на устройстве и откроется без интернета."
          actionLabel="В поиск"
          onAction={() => navigate('/search')}
        />
      ) : (
        <>
          <section className="downloads-summary">
            <div className="storage-card">
              <div className="storage-card__ring">
                <Icon name="download" size={22} />
              </div>
              <div className="storage-card__body">
                <strong>
                  {library.length} {plural(library.length, 'книга', 'книги', 'книг')} офлайн
                </strong>
                <span>
                  {humanBytes(libraryBytes)} на устройстве
                  {activeTasks.length > 0
                    ? ` · ${activeTasks.length} ${plural(activeTasks.length, 'загрузка', 'загрузки', 'загрузок')} в работе`
                    : ''}
                </span>
              </div>
              <button type="button" className="mini-button" onClick={() => navigate('/my')}>
                К полке
              </button>
            </div>

            {storageInfo && storageInfo.quota > 0 && (
              <div className="storage-line">
                <Icon name="download" size={14} />
                <span>Хранилище браузера: {humanBytes(storageInfo.usage)}</span>
                <span className="storage-line__bar">
                  <span style={{ width: `${pct(storageInfo.usage, storageInfo.quota)}%` }} />
                </span>
                <span className="downloads-summary__quota">из {humanBytes(storageInfo.quota)}</span>
              </div>
            )}

            <div className="downloads-summary__row">
              <span className="downloads-summary__hint">
                {finishedCount > 0
                  ? `${finishedCount} ${plural(finishedCount, 'задача', 'задачи', 'задач')} завершено`
                  : 'Очередь пуста'}
              </span>
              <button
                type="button"
                className="mini-button"
                onClick={clearFinished}
                disabled={finishedCount === 0}
              >
                Очистить завершённые
              </button>
            </div>
          </section>

          {activeTasks.length > 0 && (
            <section className="downloads-section">
              <div className="section__head">
                <div>
                  <h2 className="section__title">Сейчас скачивается</h2>
                  <p className="section__sub">Можно свернуть приложение — загрузка продолжится</p>
                </div>
                <span className="downloads-section__count">{activeTasks.length}</span>
              </div>
              <div className="download-queue">
                {activeTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onCancel={cancelTask}
                    onRetry={retryTask}
                    onDismiss={dismissTask}
                  />
                ))}
              </div>
            </section>
          )}

          {failedTasks.length > 0 && (
            <section className="downloads-section">
              <div className="section__head">
                <div>
                  <h2 className="section__title">Не получилось</h2>
                  <p className="section__sub">Проверьте интернет и повторите — файл докачается с начала</p>
                </div>
                <span className="downloads-section__count">{failedTasks.length}</span>
              </div>
              <div className="download-queue">
                {failedTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onCancel={cancelTask}
                    onRetry={retryTask}
                    onDismiss={dismissTask}
                  />
                ))}
              </div>
            </section>
          )}

          {doneTasks.length > 0 && (
            <section className="downloads-section">
              <div className="section__head">
                <div>
                  <h2 className="section__title">Завершённые</h2>
                  <p className="section__sub">Файлы уже в библиотеке — можно убрать строки из списка</p>
                </div>
                <span className="downloads-section__count">{doneTasks.length}</span>
              </div>
              <div className="download-queue">
                {doneTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onCancel={cancelTask}
                    onRetry={retryTask}
                    onDismiss={dismissTask}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="downloads-section">
            <div className="section__head">
              <div>
                <h2 className="section__title">Скачано</h2>
                <p className="section__sub">
                  {library.length > 0
                    ? `${library.length} ${plural(library.length, 'книга', 'книги', 'книг')} · ${humanBytes(
                        libraryBytes,
                      )}`
                    : 'Здесь появятся книги, доступные без интернета'}
                </p>
              </div>
            </div>
            {library.length > 0 ? (
              <div className="download-list">
                {library.map((networkBook) => (
                  <div className="download-item download-item--library" key={networkBook.id}>
                    <button
                      type="button"
                      className="download-item__main"
                      onClick={() => openLibraryBook(networkBook)}
                    >
                      <NetworkCover
                        book={{
                          title: networkBook.title,
                          authors: networkBook.authors,
                          coverUrl: networkBook.coverUrl,
                        }}
                        size="xs"
                      />
                      <span className="download-item__info">
                        <span className="download-item__title">{networkBook.title}</span>
                        <span className="download-item__meta">{networkBookMeta(networkBook)}</span>
                      </span>
                    </button>
                    <div className="download-item__actions">
                      <button
                        type="button"
                        className="mini-button"
                        onClick={() => openCatalogBook(catalogIdOf(networkBook))}
                      >
                        Скачать снова
                      </button>
                      <button
                        type="button"
                        className={`download-item__delete ${confirmId === networkBook.id ? 'is-danger' : ''}`}
                        onClick={() => removeLibraryBook(networkBook)}
                        aria-label={`Удалить скачанную книгу «${networkBook.title}»`}
                      >
                        {confirmId === networkBook.id ? 'Удалить?' : <Icon name="trash" size={17} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="downloads-library-empty">
                <Icon name="download" size={20} />
                <span>Ничего не скачано — книги появятся здесь после загрузки из каталога.</span>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function TaskCard({
  task,
  onCancel,
  onRetry,
  onDismiss,
}: {
  task: DownloadTask;
  onCancel: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
}) {
  const active = isActive(task.status);
  const percent = Math.min(100, Math.max(0, task.progress.percent || 0));
  const showTotal = task.progress.total > 0;

  return (
    <article
      className={`download-task ${task.status === 'error' ? 'is-error' : ''} ${
        task.status === 'ready' ? 'is-done' : ''
      }`}
    >
      <div className="download-task__head">
        <NetworkCover
          book={{ title: task.book.title, authors: task.book.authors, coverUrl: task.book.coverUrl }}
          size="xxs"
        />
        <div className="download-task__body">
          <p className="download-task__title">{task.book.title}</p>
          <p className="download-task__meta">
            <span>{formatLabel(task.format)}</span>
            <span className="lib-dot">·</span>
            <span>{STAGE_LABEL[task.status]}</span>
            {showTotal && (
              <>
                <span className="lib-dot">·</span>
                <span>
                  {humanBytes(task.progress.loaded)} из {humanBytes(task.progress.total)}
                </span>
              </>
            )}
            {task.retries > 0 && (
              <>
                <span className="lib-dot">·</span>
                <span>попыток: {task.retries}</span>
              </>
            )}
          </p>
        </div>
        {active && <span className="download-task__percent">{percent}%</span>}
      </div>

      {active && (
        <div className="download-task__bar">
          <ProgressBar value={percent} height={5} />
        </div>
      )}

      {task.error && <p className="download-task__error">{task.error}</p>}

      <div className="download-task__actions">
        {active && (
          <button type="button" className="mini-button" onClick={() => onCancel(task.id)}>
            Отменить
          </button>
        )}
        {(task.status === 'error' || task.status === 'cancelled') && (
          <>
            <button
              type="button"
              className="mini-button mini-button--primary"
              onClick={() => onRetry(task.id)}
            >
              Повторить
            </button>
            <button type="button" className="mini-button" onClick={() => onDismiss(task.id)}>
              Убрать
            </button>
          </>
        )}
        {task.status === 'ready' && (
          <button type="button" className="mini-button" onClick={() => onDismiss(task.id)}>
            Убрать
          </button>
        )}
      </div>
    </article>
  );
}

function EmptyState({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title: string;
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name="download" size={26} />
      </div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__text">{text}</p>
      <button type="button" className="btn btn--ghost" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
