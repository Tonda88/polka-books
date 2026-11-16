/**
 * Project Gutenberg — доступ через официальную коллекцию Gutenberg в Internet Archive.
 *
 * Важно: прямой gutenberg.org недоступен (отдаёт HTTP 503) и не открывает CORS,
 * поэтому источник работает с тем же корпусом свободных текстов через API
 * Internet Archive (q=collection:gutenberg AND mediatype:texts). IA — официальное
 * зеркало Project Gutenberg, файлы легальны и скачиваются напрямую.
 *
 * Форматы: EPUB / PDF / TXT из файлов записи IA.
 */
import { makeId } from '../normalize';
import {
  iaAdvancedSearch,
  iaAuthors,
  iaCoverUrl,
  iaDescriptionOf,
  iaFetchItem,
  iaFiles,
  iaIsRestricted,
  iaLanguagesOf,
  iaPublishersOf,
  iaSubjectsOf,
  iaText,
  iaTextClauses,
  iaYearOf,
  limitOf,
  mapLimited,
  iaQuote,
} from './internetArchive';
import type { IaItemResponse, IaSort } from './internetArchive';
import type { BookFormat, BookSource, CatalogBook, SearchQuery, SourceContext, SourceHealth } from '../types';

const SOURCE_ID = 'gutenberg';
const SOURCE_NAME = 'Project Gutenberg';
const DETAILS_URL = 'https://archive.org/details/';
const LICENSE = 'Общественное достояние (Project Gutenberg)';
const MIRROR_NOTE =
  'Тексты Project Gutenberg через Internet Archive: gutenberg.org недоступен напрямую, IA — официальное зеркало';

/** Через IA доступны только эти форматы свободных текстов. */
const GUTENBERG_FORMATS: readonly BookFormat[] = ['epub', 'pdf', 'txt'];

/** Запрос по коллекции Gutenberg + фильтры открытых материалов. */
function gutenbergQuery(query: SearchQuery): string {
  const clauses: string[] = [
    'collection:gutenberg',
    'mediatype:texts',
    ...iaTextClauses({ ...query, text: undefined }),
  ];
  if (query.text) clauses.push(`(title:(${iaQuote(query.text)}) OR creator:(${iaQuote(query.text)}))`);
  clauses.push('-collection:inlibrary', '-collection:printdisabled');
  return clauses.join(' AND ');
}

/** Собирает CatalogBook из записи коллекции Gutenberg. */
function toBook(identifier: string, item: IaItemResponse): CatalogBook {
  const metadata = item.metadata ?? {};
  const pageUrl = `${DETAILS_URL}${encodeURIComponent(identifier)}`;
  return {
    id: makeId(SOURCE_ID, identifier),
    sourceId: SOURCE_ID,
    externalId: identifier,
    title: iaText(metadata.title, 300) ?? identifier,
    authors: iaAuthors(metadata),
    year: iaYearOf(metadata),
    publishers: nonEmpty(iaPublishersOf(metadata)),
    languages: nonEmpty(iaLanguagesOf(metadata)),
    description: iaDescriptionOf(metadata),
    subjects: iaSubjectsOf(metadata),
    coverUrl: iaCoverUrl(identifier),
    files: iaFiles(identifier, item, GUTENBERG_FORMATS),
    access: 'download',
    accessNote: MIRROR_NOTE,
    source: {
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      pageUrl,
      license: `${LICENSE}; ${MIRROR_NOTE}`,
    },
    fetchedAt: Date.now(),
  };
}

function nonEmpty(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined;
}

/** Поиск и загрузка файлов пачками (не больше limit записей). */
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
      // Без EPUB/PDF/TXT запись бесполезна для читалки — пропускаем.
      if (iaFiles(identifier, item, GUTENBERG_FORMATS).length === 0) continue;
      books.push(toBook(identifier, item));
      if (books.length >= limit) break;
    }
  }
  return books;
}

export const gutenbergSource: BookSource = {
  id: SOURCE_ID,
  name: SOURCE_NAME,
  homepage: 'https://www.gutenberg.org',
  licenseNote: `${LICENSE}. ${MIRROR_NOTE}`,
  capabilities: {
    search: true,
    byIsbn: false,
    newest: true,
    popular: true,
    bySubject: true,
    download: true,
    audio: false,
  },

  async search(query: SearchQuery, ctx: SourceContext): Promise<CatalogBook[]> {
    const sort: IaSort | undefined =
      query.sort === 'newest' ? 'publicdate desc' : query.sort === 'popular' ? 'downloads desc' : undefined;
    return collect(gutenbergQuery(query), sort, ctx);
  },

  async newest(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(gutenbergQuery({}), 'publicdate desc', ctx);
  },

  async popular(ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(gutenbergQuery({}), 'downloads desc', ctx);
  },

  async bySubject(subject: string, ctx: SourceContext): Promise<CatalogBook[]> {
    return collect(gutenbergQuery({ subject }), undefined, ctx);
  },

  async health(ctx: SourceContext): Promise<SourceHealth> {
    try {
      const docs = await iaAdvancedSearch(gutenbergQuery({}), 'downloads desc', ctx, 1);
      return {
        ok: docs.length > 0,
        note:
          docs.length > 0
            ? 'Коллекция Gutenberg доступна через Internet Archive'
            : 'Коллекция Gutenberg не вернула записей',
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
