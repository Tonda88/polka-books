/**
 * Универсальный интернет-поиск книг: контракты.
 *
 * Приложение не зависит от фиксированного списка книжных сервисов:
 * запрос уходит в серверный агрегатор поисковых API (Google CSE, Bing,
 * Brave, Яндекс, Marginalia, Crossref, OpenAlex и открытые библиотеки).
 * Найденные страницы анализируются, из них извлекаются файлы книг,
 * которые проверяются и скачиваются прямо в приложение.
 */

export interface SearchHit {
  engine: string;
  url: string;
  title: string;
  snippet: string;
  score?: number;
  coverUrl?: string;
  /** 'library' — открытая библиотека, 'metadata' — только метаданные, иначе веб-страница. */
  kind?: 'library' | 'metadata' | 'web';
}

export interface SearchAnswer {
  query: string;
  results: SearchHit[];
  errors: Array<{ engine: string; name?: string; message: string }>;
  engines: string[];
  tookMs?: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  requiresKey: boolean;
  note: string;
  available: boolean;
}

export type FileAccess = 'ok' | 'requiresAuth' | 'purchase' | 'missing' | 'blocked' | 'unavailable' | 'invalid';

export interface BookFile {
  url: string;
  format: string;
  label?: string;
  sizeBytes?: number;
  /** Статус проверки ссылки (DownloadLinkValidator). */
  access: FileAccess;
  message: string;
  mime?: string;
}

export interface BookCandidate {
  id: string;
  title: string;
  authors: string[];
  description?: string;
  coverUrl?: string;
  language?: string;
  year?: number;
  isbn?: string;
  /** Страница, с которой получены данные. */
  pageUrl: string;
  /** Провайдер, через который найдена страница. */
  engine: string;
  files: BookFile[];
  /** Есть ли файл, который реально можно скачать. */
  downloadable: boolean;
  /** Страница не дала файлов — почему. */
  reason?: string;
  /** Оценка уверенности, что это та самая книга. */
  confidence: number;
}

export interface InternetSearchResult {
  query: string;
  books: BookCandidate[];
  providers: ProviderStatus[];
  /** Провайдеры с ключом, но без настроенного ключа. */
  unavailable: ProviderStatus[];
  errors: Array<{ engine: string; message: string }>;
  tookMs: number;
}
