/**
 * SearchProvider: официальные поисковые системы и шаблоны запросов.
 *
 * Никакого парсинга выдачи — только формирование URL и открытие реальной
 * страницы поиска. Так пользователь видит настоящий интернет-поиск,
 * а приложение не нарушает условия поисковиков.
 */
import type { SearchEngine, SearchEngineId, SearchPreset, WebQuery } from './types';

function encode(value: string): string {
  return encodeURIComponent(value.replace(/\s+/g, ' ').trim());
}

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: 'google',
    name: 'Google',
    homepage: 'https://www.google.com',
    buildUrl: (query) => `https://www.google.com/search?q=${encode(query)}&hl=ru`,
    note: 'Самый большой индекс; выдачу открываем в браузере, без парсинга',
    hue: 217,
  },
  {
    id: 'yandex',
    name: 'Яндекс',
    homepage: 'https://yandex.ru',
    buildUrl: (query) => `https://yandex.ru/search/?text=${encode(query)}&lr=213`,
    note: 'Лучше ищет русскоязычные сайты и библиотеки',
    hue: 0,
  },
  {
    id: 'bing',
    name: 'Bing',
    homepage: 'https://www.bing.com',
    buildUrl: (query) => `https://www.bing.com/search?q=${encode(query)}&setlang=ru`,
    note: 'Альтернативный индекс, хорош для PDF и старых изданий',
    hue: 195,
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    homepage: 'https://duckduckgo.com',
    buildUrl: (query) => `https://duckduckgo.com/?q=${encode(query)}&kl=ru-ru`,
    note: 'Приватный поиск без профилирования',
    hue: 30,
  },
];

export const SEARCH_PRESETS: SearchPreset[] = [
  { id: 'any', label: 'Любой', suffix: '' },
  { id: 'epub', label: 'EPUB', suffix: 'скачать EPUB' },
  { id: 'fb2', label: 'FB2', suffix: 'скачать FB2' },
  { id: 'pdf', label: 'PDF', suffix: 'скачать PDF' },
  { id: 'txt', label: 'TXT', suffix: 'скачать TXT' },
  { id: 'mobi', label: 'MOBI', suffix: 'скачать MOBI' },
  { id: 'audiobook', label: 'Аудио', suffix: 'аудиокнига слушать' },
];

export function getEngine(id: SearchEngineId): SearchEngine {
  return SEARCH_ENGINES.find((engine) => engine.id === id) ?? SEARCH_ENGINES[0];
}

export function getPreset(id: SearchPreset['id']): SearchPreset {
  return SEARCH_PRESETS.find((preset) => preset.id === id) ?? SEARCH_PRESETS[0];
}

/** Собирает строку запроса: «Ведьмак Анджей Сапковский скачать EPUB». */
export function buildQueryText(title: string, author: string | undefined, preset: SearchPreset['id']): string {
  const parts = [title.trim(), author?.trim(), getPreset(preset).suffix].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Полный WebQuery с URL поиска. */
export function buildWebQuery(
  title: string,
  author: string | undefined,
  preset: SearchPreset['id'],
  engineId: SearchEngineId,
): WebQuery {
  const text = buildQueryText(title, author, preset);
  const engine = getEngine(engineId);
  return {
    title: title.trim(),
    author: author?.trim() || undefined,
    preset,
    engine: engineId,
    text,
    url: engine.buildUrl(text),
    at: Date.now(),
  };
}

/** Дополнительные запросы, которые полезно предложить (epub/fb2/pdf). */
export function suggestedQueries(title: string, author?: string): WebQuery[] {
  const presets: SearchPreset['id'][] = ['epub', 'fb2', 'pdf', 'txt'];
  return presets.map((preset) => buildWebQuery(title, author, preset, 'google'));
}
