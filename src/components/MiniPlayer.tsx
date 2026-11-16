import { getBook } from '../data/books';
import { navigate } from '../lib/router';
import { usePlayer } from '../lib/player';
import { BookCover } from './Cover';
import { Icon } from './Icons';

export function MiniPlayer() {
  const player = usePlayer();
  const snapshot = player.snapshot;
  const book = getBook(snapshot?.bookId);
  if (!snapshot || !book) return null;
  const chapterTitle = player.content?.chapters[snapshot.chapter]?.title;

  return (
    <div
      className="mini-player"
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/listen/${book.id}`)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') navigate(`/listen/${book.id}`);
      }}
    >
      <div className="mini-player__progress">
        <span style={{ width: `${Math.max(2, snapshot.percent)}%` }} />
      </div>
      <BookCover book={book} size="xs" />
      <div className="mini-player__body">
        <div className="mini-player__title">{book.title}</div>
        <div className="mini-player__meta">
          {snapshot.engine === 'sim' ? 'демо-озвучка' : 'аудиокнига'} · {chapterTitle ?? 'Глава'}
        </div>
      </div>
      <button
        type="button"
        className="mini-player__button"
        aria-label={snapshot.playing ? 'Пауза' : 'Слушать'}
        onClick={(event) => {
          event.stopPropagation();
          player.toggle();
        }}
      >
        <Icon name={snapshot.playing ? 'pause' : 'play'} size={20} />
      </button>
      <button
        type="button"
        className="mini-player__button"
        aria-label="Следующий абзац"
        onClick={(event) => {
          event.stopPropagation();
          player.next();
        }}
      >
        <Icon name="skipForward" size={20} />
      </button>
    </div>
  );
}
