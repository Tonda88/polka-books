/**
 * LibriVox — аудиокниги общественного достояния.
 *
 * Официальные записи LibriVox лежат в Internet Archive
 * (q=collection:librivoxaudio AND mediatype:audio), поэтому источник
 * работает напрямую с API IA: дорожки — это файлы записи, метаданные
 * (главы, чтецы, язык) — из /metadata/<identifier>.
 */
import { cleanText, makeId, uniqueStrings } from '../normalize';
import {
  iaAdvancedSearch,
  iaAuthors,
  iaCoverUrl,
  iaDescriptionOf,
  iaDownloadUrl,
  iaFetchItem,
  iaIsRestricted,
  iaLanguagesOf,
  iaSubjectsOf,
  iaText,
  iaTextClauses,
  iaYearOf,
  limitOf,
  mapLimited,
  toList,
  iaQuote,
} from './internetArchive';
import type { IaItemResponse, IaMetadata, IaSort } from './internetArchive';
import type {
  AudioInfo,
  AudioTrack,
  BookSource,
  CatalogBook,
  SearchQuery,
  SourceContext,
  SourceHealth,
} from '../types';

const SOURCE_ID = 'librivox';
const SOURCE_NAME = 'LibriVox';
const DETAILS_URL = 'https://archive.org/details/';
const LIBRIVOX_URL = 'https://librivox.org/';
const LICENSE = 'Аудиокниги общественного достояния (LibriVox)';

/** Запрос по коллекции LibriVox. */
function librivoxQuery(query: SearchQuery): string {
  const clauses: string[] = ['collection:librivoxaudio', 'mediatype:audio', ...iaTextClauses({ ...query, text: undefined })];
  // Свободный текст ищем только по названию и автору: иначе в выдачу
  // попадают записи, где слово встретилось в описании.
  if (query.text) clauses.push(`(title:(${iaQuote(query.text)}) OR creator:(${iaQuote(query.text)}))`);
  return clauses.join(' AND ');
}

/** Длительность из поля length: «640.61» (сек) или «10:40». */
function durationOf(length?: string): number | undefined {
  if (!length) return undefined;
  if (/^\d+(\.\d+)?$/.test(length)) {
    const seconds = Number(length);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : undefined;
  }
  const parts = length.split(':').map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return total > 0 ? total : undefined;
}

/** Название главы: title файла, иначе аккуратное имя файла. */
function trackTitle(name: string, rawTitle?: string): string {
  const base = name
    .replace(/^.*\//, '')
    .replace(/\.[^.]+$/, '');
  const title = cleanText(rawTitle, 200);
  if (title && title.toLowerCase() !== base.toLowerCase()) return title;
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Глава';
}

/** MP3-дорожки записи: без _64kb-версий, по порядку имён. */
function mp3Tracks(identifier: string, item: IaItemResponse): AudioTrack[] {
  const files = (item.files ?? [])
    .filter((file) => {
      const name = file?.name ?? '';
      if (!/\.mp3$/i.test(name) || /_64kb\.mp3$/i.test(name)) return false;
      return file.private !== true && file.private !== 'true';
    })
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en', { numeric: true }));

  return files.map((file) => {
    const name = file?.name ?? '';
    const size = Number(file?.size);
    return {
      title: trackTitle(name, file?.title),
      url: iaDownloadUrl(identifier, name),
      sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
      durationSec: durationOf(file?.length),
    };
  });
}

/** Чтецы: в записях IA это поле narrator, иначе creator (по ТЗ — creator). */
function narratorsOf(metadata: IaMetadata): string[] {
  const explicit = toList(metadata.narrator);
  const raw = explicit.length > 0 ? explicit : toList(metadata.creator);
  const names = raw.map((value) => cleanText(value, 120));
  return uniqueStrings(names).slice(0, 5);
}

/** Склонение слова «глава» для подписи. */
function chaptersWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'глава';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'главы';
  return 'глав';
}

/** Собирает аудиокнигу; без MP3 запись не нужна. */
function toBook(identifier: string, item: IaItemResponse): CatalogBook | null {
  const tracks = mp3Tracks(identifier, item);
  if (tracks.length === 0) return null;
  const metadata = item.metadata ?? {};
  const languages = iaLanguagesOf(metadata);
  const firstTrack = tracks[0];
  const pageUrl = `${DETAILS_URL}${encodeURIComponent(identifier)}`;
  const audio: AudioInfo = {
    tracks,
    narrators: narratorsOf(metadata),
    language: languages.length > 0 ? languages.join(', ') : undefined,
    sourceUrl: LIBRIVOX_URL,
  };

  return {
    id: makeId(SOURCE_ID, identifier),
    sourceId: SOURCE_ID,
    externalId: identifier,
    title: iaText(metadata.title, 300) ?? identifier,
    authors: iaAuthors(metadata),
    year: iaYearOf(metadata),
    languages: languages.length > 0 ? languages : undefined,
    description: iaDescriptionOf(metadata),
    subjects: iaSubjectsOf(metadata),
    coverUrl: iaCoverUrl(identifier),
    files: [
      {
        url: firstTrack.url,
        format: 'audio',
        sizeBytes: firstTrack.sizeBytes,
        label: `MP3, ${tracks.length} ${chaptersWord(tracks.length)}`,
        requiresAuth: false,
      },
    ],
    access: 'download',
    accessNote: 'Записи LibriVox — общественное достояние; MP3 скачиваются с Internet Archive',
    audio,
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl,
      license: LICENSE,
    },
    fetchedAt: Date.now(),
  };
}

/** Поиск и загрузка дорожек пачками (не больше limit записей). */
async function collect(query: string, sort: IaSort | undefined, ctx: SourceContext): Promise<CatalogBook[]> {
  const limit = limitOf(ctx);
  const docs = await iaAdvancedSearch(query, sort, ctx, limit);
  const identifiers = docs
    .map((doc) => doc.identifier)
    .filter((value): value is string => Boolean(value));

  const books: CatalogBook[] = [];
  const chunkSize = 6;
  for (let start = 0; start < identifiers.length && books.length < limit; start += chunkSize) {
    const chunk = identifiers.slice(start, start + chunkSize);
    const items = await mapLimited(chunk, chunkSize, (identifier) => iaFetchItem(identifier, ctx));
    for (let index = 0; index < chunk.length; index += 1) {
      const identifier = chunk[index];
      const item = items[index];
      if (!identifier || !item || iaIsRestricted(item)) continue;
      const book = toBook(identifier, item);
      if (!book) continue; // нет mp3 — не возвращаем
      books.push(book);
      if (books.length >= limit) break;
    }
  }
  return books;
}

export const librivoxSource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: LIBRIVOX_URL,
  licenseNote: `${LICENSE}; файлы — Internet Archive (официальное зеркало LibriVox)`,
  capabilities: {
    search: true,
    byIsbn: false,
    newest: true,
    popular: true,
    bySubject: true,
    download: true,
    audio: true,
  },

  async search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]> {
    const sort: IaSort | undefined =
      query.sort === 'newest' ? 'publicdate desc' : query.sort === 'popular' ? 'downloads desc' : undefined;
    return collect(librivoxQuery(query), sort, ctx);
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(librivoxQuery({}), 'publicdate desc', ctx);
  },

  async popular(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(librivoxQuery({}), 'downloads desc', ctx);
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(librivoxQuery({ subject }), undefined, ctx);
  },

  async health(ctx: SourceContext): Promise<SourceHealth> {
    try {
      const docs = await iaAdvancedSearch(librivoxQuery({}), 'downloads desc', ctx, 1);
      return {
        ok: docs.length > 0,
        note: docs.length > 0 ? 'Коллекция LibriVox доступна через Internet Archive' : 'Аудиокниги не найдены',
        checkedAt: Date.now(),
      };
    } catch (error) {
      return {
        ok: false,
        note: error instanceof Error ? error.message : 'Источник недоступен',
        checkedAt: Date.now(),
      };
    }
  },
};
