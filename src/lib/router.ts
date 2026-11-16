import { useSyncExternalStore } from 'react';

export type Screen =
  | 'home'
  | 'catalog'
  | 'library'
  | 'goals'
  | 'profile'
  | 'book'
  | 'reader'
  | 'player'
  // --- мульти-источниковый каталог ---
  | 'search'
  | 'details'
  | 'mybooks'
  | 'downloads'
  | 'audio'
  // --- персональные предпочтения ---
  | 'prefs'
  // --- интернет-поиск и импорт ---
  | 'web';

export interface Route {
  screen: Screen;
  id?: string;
  chapter?: number;
  paragraph?: number;
}

const MAIN_SCREENS: Screen[] = ['home', 'search', 'mybooks', 'goals', 'profile', 'library', 'catalog'];

export function isMainScreen(screen: Screen): boolean {
  return MAIN_SCREENS.includes(screen);
}

const SCREEN_PATHS: Record<string, Screen> = {
  '': 'home',
  home: 'home',
  catalog: 'catalog',
  library: 'library',
  my: 'mybooks',
  goals: 'goals',
  me: 'profile',
  profile: 'profile',
  book: 'book',
  read: 'reader',
  listen: 'player',
  player: 'player',
  search: 'search',
  book_details: 'details',
  downloads: 'downloads',
  audio: 'audio',
  prefs: 'prefs',
  web: 'web',
};

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length === 0) return { screen: 'home' };

  // /catalog/book/<bookId> — карточка книги из сетевого каталога.
  if (segments[0] === 'catalog' && segments[1] === 'book') {
    return { screen: 'details', id: decodeURIComponent(segments[2] ?? '') };
  }
  // /read/<bookId>[/<chapter>[/<paragraph>]] и /listen/<bookId>
  if (segments[0] === 'audio') {
    return { screen: 'audio', id: decodeURIComponent(segments[1] ?? '') };
  }

  const screen = SCREEN_PATHS[segments[0]] ?? 'home';
  if (screen === 'book' || screen === 'reader' || screen === 'player') {
    const chapter = segments[2] !== undefined ? Number(segments[2]) : undefined;
    const paragraph = segments[3] !== undefined ? Number(segments[3]) : undefined;
    return {
      screen,
      id: decodeURIComponent(segments[1] ?? ''),
      chapter: Number.isFinite(chapter) ? chapter : undefined,
      paragraph: Number.isFinite(paragraph) ? paragraph : undefined,
    };
  }
  if (screen === 'details' || screen === 'audio' || screen === 'search') {
    return { screen, id: segments[1] ? decodeURIComponent(segments[1]) : undefined };
  }
  return { screen };
}

let cachedHash: string | null = null;
let cachedRoute: Route = { screen: 'home' };

function getSnapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseRoute(hash);
  }
  return cachedRoute;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function toPath(route: Route): string {
  switch (route.screen) {
    case 'home':
      return '/';
    case 'profile':
      return '/me';
    case 'mybooks':
      return '/my';
    case 'details':
      return `/catalog/book/${encodeURIComponent(route.id ?? '')}`;
    case 'prefs':
      return '/prefs';
    case 'web':
      return '/web';
    case 'audio':
      return `/audio/${encodeURIComponent(route.id ?? '')}`;
    case 'book':
    case 'reader':
    case 'player': {
      const base = route.screen === 'book' ? 'book' : route.screen === 'reader' ? 'read' : 'listen';
      const chapterSuffix =
        route.screen === 'reader' && route.chapter !== undefined
          ? `/${route.chapter}${route.paragraph !== undefined ? `/${route.paragraph}` : ''}`
          : '';
      return `/${base}/${encodeURIComponent(route.id ?? '')}${chapterSuffix}`;
    }
    default:
      return `/${route.screen}`;
  }
}

export function navigate(route: Route | string): void {
  const path = typeof route === 'string' ? route : toPath(route);
  if (window.location.hash === `#${path}`) return;
  window.location.hash = path;
  if (!path.startsWith('/read/') && !path.startsWith('/listen/') && !path.startsWith('/audio/')) {
    window.scrollTo({ top: 0 });
  }
}

export function navigateHome(): void {
  navigate('/');
}

export function openReader(bookId: string, chapter?: number, paragraph?: number): void {
  navigate({ screen: 'reader', id: bookId, chapter, paragraph });
}

export function openPlayer(bookId?: string): void {
  if (bookId) navigate({ screen: 'player', id: bookId });
  else navigate('/player');
}

export function openBook(bookId: string): void {
  navigate({ screen: 'book', id: bookId });
}

/** Карточка книги из сетевого каталога (id вида `source:externalId`). */

/** Экран «Поиск в интернете». */
export function openWebSearch(): void {
  navigate('/web');
}

/** Экран «Вкус и предпочтения». */
export function openPreferences(): void {
  navigate('/prefs');
}

export function openCatalogBook(bookId: string): void {
  navigate({ screen: 'details', id: bookId });
}

export function openSearch(query?: string): void {
  navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
}

export function openMyBooks(): void {
  navigate('/my');
}

export function openDownloads(): void {
  navigate('/downloads');
}

export function openAudioBook(bookId: string): void {
  navigate({ screen: 'audio', id: bookId });
}

/** Текущий поисковый запрос из hash (#/search?q=...). */
export function getSearchQuery(): string {
  const raw = window.location.hash;
  const index = raw.indexOf('?');
  if (index === -1) return '';
  const params = new URLSearchParams(raw.slice(index + 1));
  return params.get('q') ?? '';
}
