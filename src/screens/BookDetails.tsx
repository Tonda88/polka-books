import { useEffect, useState } from 'react';
import type { CatalogBook, DownloadFile } from '../catalog/types';
import { useBookDetails, useDownloadedBook, useDownloadTasks } from '../catalog/hooks';
import { verifyBookFiles, type VerifiedBook } from '../catalog/availability';
import { bookLanguageLabel, categoriesOf } from '../catalog/classify';
import { downloads } from '../downloads/manager';
import type { DownloadStatus, DownloadTask } from '../downloads/types';
import { formatMinutes, formatNumber, humanBytes, plural } from '../lib/format';
import { navigate, openAudioBook, openReader } from '../lib/router';
import { useAppOptional } from '../lib/store';
import { formatLabel, sourceVariables } from '../components/CatalogCard';
import { FavoriteButton } from '../components/FavoriteButton';
import { Icon } from '../components/Icons';
import { NetworkCover } from '../components/NetworkCover';
import { ProgressBar } from '../components/Progress';
import { RatingWidget } from '../components/RatingWidget';
import { ShelfRow } from '../components/ShelfRow';
import { useSimilarBooks } from '../prefs/usePreferences';
import { recordDownload, recordView } from '../prefs/repository';
import { Stars } from '../components/Stars';

const RUNNING_STATUSES: ReadonlySet<DownloadStatus> = new Set([
  'queued',
  'downloading',
  'validating',
  'processing',
]);

const STAGE_LABELS: Record<DownloadStatus, string> = {
  queued: 'В очереди',
  downloading: 'Загрузка',
  validating: 'Проверка файла',
  processing: 'Разбор текста',
  ready: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else navigate('/search');
}

function accessCopy(book: CatalogBook): { title: string; text: string; icon: string; tone: string } {
  switch (book.access) {
    case 'download':
      return {
        title: 'Можно скачать бесплатно',
        text: book.accessNote ?? 'Источник отдаёт файлы свободно — скачайте книгу и читайте без интернета.',
        icon: 'download',
        tone: 'download',
      };
    case 'borrow':
      return {
        title: 'Доступно по подписке или в библиотеке',
        text:
          book.accessNote ??
          'Книга есть у источника, но взять её можно по подписке или через библиотеку. Мы не обходим ограничения — откроем официальную страницу.',
        icon: 'library',
        tone: 'borrow',
      };
    case 'buy':
      return {
        title: 'Книгу можно купить',
        text: book.accessNote ?? 'Книга продаётся у источника — перейдите на его страницу, чтобы купить или уточнить цену.',
        icon: 'book',
        tone: 'buy',
      };
    case 'preview':
      return {
        title: 'Только превью',
        text: book.accessNote ?? 'Источник показывает фрагмент книги. Полный текст доступен на его сайте.',
        icon: 'book',
        tone: 'preview',
      };
    default:
      return {
        title: 'Условия доступа уточняются',
        text: book.accessNote ?? 'Источник не уточнил условия доступа — проверьте его официальную страницу.',
        icon: 'compass',
        tone: 'unknown',
      };
  }
}

export function BookDetailsScreen({ bookId }: { bookId: string }) {
  const { book, loading, error, offline, fromCache, refresh } = useBookDetails(bookId);

  if (loading && !book) {
    return (
      <div className="screen details-screen">
        <div className="details-topbar">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
        </div>
        <div className="details-skeleton" aria-hidden="true">
          <div className="details-skeleton__hero">
            <div className="skeleton details-skeleton__cover" />
            <div className="details-skeleton__lines">
              <span className="skeleton skeleton--line details-skeleton__line details-skeleton__line--short" />
              <span className="skeleton skeleton--line details-skeleton__line" />
              <span className="skeleton skeleton--line details-skeleton__line details-skeleton__line--mid" />
            </div>
          </div>
          <div className="details-skeleton__actions">
            <span className="skeleton details-skeleton__button" />
            <span className="skeleton details-skeleton__button" />
          </div>
          <div className="details-skeleton__lines">
            <span className="skeleton skeleton--line details-skeleton__line" />
            <span className="skeleton skeleton--line details-skeleton__line" />
            <span className="skeleton skeleton--line details-skeleton__line details-skeleton__line--mid" />
          </div>
        </div>
        <p className="details-loading-hint" role="status">
          Загружаем карточку книги…
        </p>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="screen details-screen">
        <div className="details-topbar">
          <button type="button" className="icon-button" onClick={goBack} aria-label="Назад">
            <Icon name="left" size={22} />
          </button>
        </div>
        <div className="empty">
          <div className="empty__icon">
            <Icon name={offline ? 'wifiOff' : 'book'} size={26} />
          </div>
          <h2 className="empty__title">{offline ? 'Нет сети' : 'Книга не найдена'}</h2>
          <p className="empty__text">
            {error ?? 'Возможно, ссылка устарела. Попробуйте найти книгу в поиске.'}
          </p>
          <div className="empty__actions">
            {offline ? (
              <button type="button" className="btn btn--ghost" onClick={refresh}>
                Повторить
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={() => navigate('/search')}>
                В поиск
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <BookDetailsContent book={book} offline={offline} fromCache={fromCache} refresh={refresh} />;
}

function DetailsHero({ book }: { book: CatalogBook }) {
  const publisher = book.publishers?.[0];
  const language = bookLanguageLabel(book);
  const category = categoriesOf(book)[0]?.label;
  const facts = [
    book.year ? String(book.year) : null,
    publisher ?? null,
    language ?? null,
    category ?? null,
  ].filter((item): item is string => Boolean(item));

  return (
    <header className="details-hero" style={sourceVariables(book.sourceId)}>
      <div className="details-hero__bar">
        <button type="button" className="icon-button icon-button--glass" onClick={goBack} aria-label="Назад">
          <Icon name="left" size={22} />
        </button>
        <FavoriteButton bookId={book.id} />
      </div>

      <div className="details-hero__content">
        <div className="details-hero__cover">
          <NetworkCover book={book} size="xl" />
        </div>
        <div className="details-hero__text">
          <div className="details-hero__source">{book.source.sourceName}</div>
          <h1 className="details-hero__title">{book.title}</h1>
          {book.subtitle && <p className="details-hero__subtitle">{book.subtitle}</p>}
          <p className="details-hero__author">
            {book.authors.length > 0 ? book.authors.join(', ') : 'Автор неизвестен'}
          </p>
          {facts.length > 0 && <p className="details-hero__facts">{facts.join(' · ')}</p>}
          {typeof book.rating === 'number' && (
            <div className="details-hero__rating">
              <Stars value={book.rating} size={14} />
              <strong>{book.rating.toFixed(1)}</strong>
              {book.ratingsCount ? <span>· {formatNumber(book.ratingsCount)} оценок</span> : null}
            </div>
          )}
        </div>
      </div>

      {book.subjects.length > 0 && (
        <div className="chips-row chips-row--wrap details-hero__genres">
          {book.subjects.slice(0, 6).map((subject) => (
            <span key={subject} className="chip chip--static">
              {subject}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

function BookDetailsContent({
  book,
  offline,
  fromCache,
  refresh,
}: {
  book: CatalogBook;
  offline: boolean;
  fromCache: boolean;
  refresh: () => void;
}) {
  const app = useAppOptional();
  const downloaded = useDownloadedBook(book.id);
  const tasks = useDownloadTasks(book.id);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Результат проверки доступности файлов (HEAD/Range-запросы).
  const [verified, setVerified] = useState<VerifiedBook | null>(null);
  const [checkingFiles, setCheckingFiles] = useState(false);
  const bookView: VerifiedBook = verified ?? { ...book, files: book.files };
  const similar = useSimilarBooks(book, 8);

  // Открытие карточки — сигнал интереса для рекомендаций (слабее скачивания).
  useEffect(() => {
    void recordView(book);
  }, [book.id]);

  const audio = book.audio;
  const canListen = Boolean(audio && audio.tracks.length > 0);
  const downloadable = book.files.some((file) => !file.requiresAuth);
  const pageUrl = book.accessUrl ?? book.source.pageUrl;
  const activeTask = tasks.find((task) => RUNNING_STATUSES.has(task.status)) ?? null;
  const failedTask = tasks.find((task) => task.status === 'error') ?? null;
  const descriptionLong = (book.description?.length ?? 0) > 420;
  const access = accessCopy(book);
  const audioMinutes = audio
    ? audio.tracks.reduce((sum, track) => sum + (track.durationSec ?? 0), 0) / 60
    : 0;

  const notify = (message: string, kind: 'info' | 'success' | 'error' = 'info'): void => {
    app?.pushToast(message, kind);
  };

  const handleDownload = (file?: DownloadFile): void => {
    try {
      const task = file ? downloads.enqueue(book, file) : downloads.enqueueBest(book);
      if (!task) {
        notify('У источника нет файла, который можно скачать', 'error');
        return;
      }
      void recordDownload(book);
      notify(file ? `Скачиваем ${formatLabel(file.format)}` : 'Загрузка началась');
    } catch {
      notify('Не удалось начать загрузку', 'error');
    }
  };

  const handleCheckFiles = async (): Promise<void> => {
    if (checkingFiles) return;
    setCheckingFiles(true);
    try {
      const result = await verifyBookFiles(book);
      setVerified(result);
      const available = result.files.filter((file) => file.available).length;
      if (result.filesUnavailable) {
        notify('Файлы источника сейчас недоступны — попробуйте другой формат', 'error');
      } else {
        notify(`Проверено: доступно файлов ${available} из ${result.files.length}`, 'success');
      }
    } catch {
      notify('Не удалось проверить файлы', 'error');
    } finally {
      setCheckingFiles(false);
    }
  };

  const handleRetry = async (taskId: string): Promise<void> => {
    setRetrying(true);
    try {
      await downloads.retry(taskId);
    } catch {
      notify('Не удалось перезапустить загрузку', 'error');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="screen details-screen">
      <DetailsHero book={book} />

      <div className="details-body">
        {offline && (
          <div className="details-offline">
            <Icon name="wifiOff" size={16} />
            <span>Нет сети: показана сохранённая карточка книги</span>
          </div>
        )}
        {fromCache && !offline && (
          <div className="details-cache">
            <span>Карточка из кэша</span>
            <button type="button" className="link-button" onClick={refresh}>
              Обновить
            </button>
          </div>
        )}

        <div className="details-actions">
          {downloaded ? (
            <button type="button" className="btn btn--primary btn--wide" onClick={() => openReader(downloaded.id)}>
              <Icon name="book" size={18} />
              Читать
            </button>
          ) : downloadable ? (
            <button
              type="button"
              className="btn btn--primary btn--wide"
              onClick={() => handleDownload()}
              disabled={Boolean(activeTask)}
            >
              <Icon name="download" size={18} />
              {activeTask ? `Скачиваем ${Math.round(activeTask.progress.percent)}%` : 'Скачать'}
            </button>
          ) : pageUrl ? (
            <a className="btn btn--primary btn--wide" href={pageUrl} target="_blank" rel="noreferrer">
              <Icon name="compass" size={18} />
              Открыть у источника
            </a>
          ) : (
            <span className="details-actions__empty">Скачать у источника нельзя</span>
          )}

          {canListen && (
            <button type="button" className="btn btn--ghost btn--wide" onClick={() => openAudioBook(book.id)}>
              <Icon name="headphones" size={18} />
              Слушать
            </button>
          )}

          <FavoriteButton bookId={book.id} variant="wide" />

          {downloaded && (
            <span className="details-actions__note">
              <Icon name="check" size={14} />
              Скачано · {humanBytes(downloaded.bytes)} · доступно без интернета
            </span>
          )}
        </div>

        <RatingWidget
          book={book}
          externalRating={book.rating}
          externalRatingsCount={book.ratingsCount}
        />

        {activeTask && <DownloadProgressBlock task={activeTask} />}
        {failedTask && !activeTask && (
          <DownloadProgressBlock
            task={failedTask}
            retrying={retrying}
            onRetry={() => void handleRetry(failedTask.id)}
          />
        )}

        {book.description && (
          <section className="details-section">
            <h2>Описание</h2>
            <p className={`details-description ${descriptionOpen ? 'is-expanded' : ''}`}>{book.description}</p>
            {descriptionLong && (
              <button
                type="button"
                className="link-button details-description__toggle"
                onClick={() => setDescriptionOpen((value) => !value)}
                aria-expanded={descriptionOpen}
              >
                {descriptionOpen ? 'Свернуть' : 'Читать далее'}
              </button>
            )}
          </section>
        )}

        <section className="details-section">
          <div className="book-section__head">
            <h2>Форматы</h2>
            <span className="muted">
              {bookView.files.length > 0
                ? `${bookView.files.length} ${plural(bookView.files.length, 'файл', 'файла', 'файлов')}`
                : 'нет файлов'}
            </span>
          </div>
          {book.files.length > 0 && (
            <div className="format-check">
              <button
                type="button"
                className="mini-button"
                onClick={() => void handleCheckFiles()}
                disabled={checkingFiles}
              >
                {checkingFiles ? 'Проверяем…' : 'Проверить файлы'}
              </button>
              {verified && !checkingFiles && (
                <span className={`format-check__state ${verified.filesUnavailable ? 'is-bad' : 'is-ok'}`}>
                  {verified.filesUnavailable
                    ? 'Файлы недоступны'
                    : `Доступно: ${verified.files.filter((file) => file.available).length} из ${verified.files.length}`}
                </span>
              )}
            </div>
          )}
          {bookView.files.length > 0 ? (
            <ul className="format-list">
              {bookView.files.map((file, index) => {
                const saved = downloaded?.format === file.format;
                return (
                  <li className="format-row" key={`${file.url}-${index}`}>
                    <span className="format-row__badge">{formatLabel(file.format)}</span>
                    <span className="format-row__body">
                      <span className="format-row__title">{file.label ?? formatLabel(file.format)}</span>
                      <span className="format-row__meta">
                        {file.sizeBytes ? humanBytes(file.sizeBytes) : 'размер неизвестен'}
                        {file.requiresAuth ? ' · нужен вход у источника' : ''}
                        {file.available === true && ' · проверено'}
                        {file.available === false && ' · недоступно'}
                      </span>
                    </span>
                    {file.requiresAuth ? (
                      <a
                        className="format-row__action"
                        href={book.accessUrl ?? file.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Открыть у источника
                      </a>
                    ) : saved ? (
                      <span className="format-row__done">
                        <Icon name="check" size={14} />
                        Скачано
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="mini-button"
                        onClick={() => handleDownload(file)}
                        disabled={Boolean(activeTask) || file.available === false}
                        title={file.available === false ? 'Файл недоступен у источника' : undefined}
                      >
                        {file.available === false ? 'Недоступно' : 'Скачать'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="details-hint">
              Источник не отдал файлов для скачивания — открыть книгу можно на его официальной странице.
            </p>
          )}
          <p className="details-hint">
            Скачиваем только свободные файлы. Если файл требует входа или покупки — откроем официальную страницу источника.
            Кнопка «Проверить файлы» заранее узнаёт у источника размер и доступность — без скачивания.
          </p>
        </section>

        {canListen && audio && (
          <section className="details-section">
            <div className="book-section__head">
              <h2>Аудио</h2>
              <span className="muted">
                {audio.tracks.length} {plural(audio.tracks.length, 'дорожка', 'дорожки', 'дорожек')}
              </span>
            </div>
            <div className="details-audio">
              <span className="details-audio__icon">
                <Icon name="headphones" size={22} />
              </span>
              <div className="details-audio__body">
                <strong>
                  {audio.narrators && audio.narrators.length > 0
                    ? `Читают: ${audio.narrators.join(', ')}`
                    : 'Аудиоверсия источника'}
                </strong>
                <span>
                  {audioMinutes > 0
                    ? `${formatMinutes(audioMinutes)} · ${audio.tracks.length} ${plural(audio.tracks.length, 'дорожка', 'дорожки', 'дорожек')}`
                    : `${audio.tracks.length} ${plural(audio.tracks.length, 'дорожка', 'дорожки', 'дорожек')}`}
                </span>
              </div>
              <button type="button" className="mini-button" onClick={() => openAudioBook(book.id)}>
                Слушать
              </button>
            </div>
          </section>
        )}

        <section className={`access-note access-note--${access.tone}`}>
          <div className="access-note__head">
            <Icon name={access.icon} size={18} />
            <strong>{access.title}</strong>
          </div>
          <p>{access.text}</p>
          {pageUrl && book.access !== 'download' && (
            <a className="btn btn--ghost btn--sm" href={pageUrl} target="_blank" rel="noreferrer">
              {book.access === 'buy'
                ? 'Купить у источника'
                : book.access === 'borrow'
                  ? `Открыть ${book.source.sourceName}`
                  : 'Открыть у источника'}
            </a>
          )}
        </section>

        <section className="details-section">
          <h2>Источник</h2>
          <dl className="meta-grid">
            <div>
              <dt>Источник</dt>
              <dd>{book.source.sourceName}</dd>
            </div>
            <div>
              <dt>Лицензия</dt>
              <dd>{book.source.license ?? 'условия источника'}</dd>
            </div>
            {book.year ? (
              <div>
                <dt>Год</dt>
                <dd>{book.year}</dd>
              </div>
            ) : null}
            {book.publishers?.[0] ? (
              <div>
                <dt>Издательство</dt>
                <dd>{book.publishers[0]}</dd>
              </div>
            ) : null}
            {book.languages?.[0] ? (
              <div>
                <dt>Язык</dt>
                <dd>{book.languages[0]}</dd>
              </div>
            ) : null}
            {book.isbn?.[0] ? (
              <div>
                <dt>ISBN</dt>
                <dd>{book.isbn[0]}</dd>
              </div>
            ) : null}
            {book.series ? (
              <div>
                <dt>Серия</dt>
                <dd>{book.series}</dd>
              </div>
            ) : null}
          </dl>
          {pageUrl && (
            <a className="source-link" href={pageUrl} target="_blank" rel="noreferrer">
              Официальная страница книги у источника
              <Icon name="right" size={14} />
            </a>
          )}
          <p className="book-note">
            Если книга защищена DRM или платная — мы не обходим защиту, а отправляем к официальному источнику.
          </p>
        </section>

        {similar.length > 0 && (
          <ShelfRow
            title="Похожие книги"
            subtitle="Подобрано по жанру, темам и вашим оценкам"
            books={similar}
          />
        )}
      </div>
    </div>
  );
}

function DownloadProgressBlock({
  task,
  onRetry,
  retrying = false,
}: {
  task: DownloadTask;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const percent = Math.max(0, Math.min(100, task.progress.percent));
  const failed = task.status === 'error';

  return (
    <div className={`download-progress ${failed ? 'is-error' : ''}`} role="status" aria-live="polite">
      <div className="download-progress__head">
        <span>{failed ? 'Загрузка не удалась' : STAGE_LABELS[task.status]}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <ProgressBar value={percent} />
      <p className="download-progress__hint">
        {failed
          ? (task.error ?? 'Источник не отдал файл')
          : `${humanBytes(task.progress.loaded)}${
              task.progress.total > 0 ? ` из ${humanBytes(task.progress.total)}` : ''
            }`}
      </p>
      {failed && onRetry && (
        <button type="button" className="mini-button" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Пробуем…' : 'Повторить'}
        </button>
      )}
    </div>
  );
}
