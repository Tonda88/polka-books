export type CoverPattern = 'arc' | 'lines' | 'dots' | 'moon' | 'waves' | 'grid' | 'sun';

export interface CoverSpec {
  bg: [string, string];
  ink: string;
  accent: string;
  pattern: CoverPattern;
}

export interface BookSource {
  name: string;
  site: string;
  page: string;
  url: string;
  edition: string;
  license: string;
  retrievedAt: string;
}

export interface BookMeta {
  id: string;
  title: string;
  author: string;
  year: number;
  genres: string[];
  tags: string[];
  description: string;
  /** Печатный объём книги, стр. */
  pages: number;
  /** Длительность аудиоверсии, мин. */
  minutes: number;
  rating: number;
  reviews: number;
  narrator: string;
  cover: CoverSpec;
  chapters: string[];
  words: number;
  /** Размер полного текста книги, байт. */
  bytes: number;
  source?: BookSource;
}

export interface ChapterContent {
  title: string;
  paragraphs: string[];
}

export interface BookContent {
  id: string;
  chapters: ChapterContent[];
}

export interface ParagraphRef {
  chapter: number;
  paragraph: number;
  text: string;
  chapterTitle: string;
  startChars: number;
}

export interface BookStats {
  paragraphs: ParagraphRef[];
  totalChars: number;
  totalWords: number;
  chapterStart: number[];
}

export type Mode = 'read' | 'listen';

export interface Locator {
  chapter: number;
  paragraph: number;
}

export interface ProgressEntry extends Locator {
  bookId: string;
  percent: number;
  lastMode: Mode;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface ReadingSession {
  id: string;
  ts: number;
  /** YYYY-MM-DD в локальном времени */
  date: string;
  bookId: string;
  mode: Mode;
  minutes: number;
  pages: number;
}

export type GoalPeriod = 'week' | 'month' | 'year';
export type GoalMetric = 'books' | 'pages' | 'minutes';

export interface Goal {
  id: string;
  period: GoalPeriod;
  metric: GoalMetric;
  target: number;
  createdAt: number;
}

export interface Rating {
  bookId: string;
  stars: number;
  liked: boolean;
  at: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapter: number;
  paragraph: number;
  chapterTitle: string;
  text: string;
  at: number;
}

export interface DownloadMeta {
  bookId: string;
  bytes: number;
  at: number;
}

export interface Settings {
  theme: 'dark' | 'sepia' | 'light';
  fontScale: number;
  serif: boolean;
  ttsRate: number;
  ttsVoice: string | null;
  autoListen: boolean;
  /** Необязательный ключ Google Books API (вводится пользователем, хранится локально). */
  googleBooksKey?: string | null;
}

export interface Profile {
  name: string;
  interests: string[];
  onboarded: boolean;
  createdAt: number;
}

export interface AppState {
  profile: Profile;
  settings: Settings;
  progress: Record<string, ProgressEntry>;
  sessions: ReadingSession[];
  goals: Goal[];
  ratings: Record<string, Rating>;
  bookmarks: Bookmark[];
  downloads: Record<string, DownloadMeta>;
}

export interface DownloadProgress {
  loaded: number;
  total: number;
  percent: number;
}
