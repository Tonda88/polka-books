/**
 * Диспетчер разбора скачанных файлов: BookFormat → конкретный парсер.
 *
 * Для текстовых форматов возвращает BookContent (готов для читалки), для PDF —
 * только метаданные (файл открывается встроенным просмотрщиком), для аудио
 * разбора нет. MOBI/DJVU браузер прочитать не умеет — честно бросаем ошибку.
 */
import type { BookFormat } from '../../catalog/types';
import type { BookContent } from '../../types';
import { epubBytesToArrayBuffer, parseEpub, readZipFile, type DecompressFn } from './epub';
import { parseFb2 } from './fb2';
import { parsePdfInfo, type PdfInfo } from './pdf';
import { parseTxt } from './txt';

export { parseEpub, parseFb2, parsePdfInfo, parseTxt };
export type { DecompressFn, PdfInfo };

export interface ParseDownloadedInput {
  bytes: ArrayBuffer;
  format: BookFormat;
  url?: string;
  /** Подмена декомпрессора (для Node-тестов через node:zlib). */
  decompress?: DecompressFn;
}

export interface ParsedDownload {
  content?: BookContent;
  pdfInfo?: PdfInfo;
  format: BookFormat;
}

function looksLikeZip(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  return view.length >= 2 && view[0] === 0x50 && view[1] === 0x4b;
}

/** Разбирает скачанный файл в формате, понятном приложению. */
export async function parseDownloadedFile(input: ParseDownloadedInput): Promise<ParsedDownload> {
  const { bytes, format } = input;

  switch (format) {
    case 'epub':
      return { content: await parseEpub(bytes, input.decompress), format };
    case 'fb2': {
      // FB2 иногда распространяют упакованным в ZIP.
      if (looksLikeZip(bytes)) {
        const extracted = await readZipFile(
          bytes,
          (path) => path.toLowerCase().endsWith('.fb2'),
          input.decompress,
        );
        if (!extracted) throw new Error('FB2 в архиве: внутри ZIP-файла нет документа .fb2.');
        return { content: await parseFb2(epubBytesToArrayBuffer(extracted.data)), format };
      }
      return { content: await parseFb2(bytes), format };
    }
    case 'txt':
      return { content: await parseTxt(bytes), format };
    case 'pdf':
      return { pdfInfo: await parsePdfInfo(bytes), format };
    case 'audio':
      return { format };
    case 'mobi':
      throw new Error('MOBI: браузер не умеет читать этот формат; выберите EPUB/PDF/TXT');
    case 'html':
      throw new Error('Источник вернул HTML-страницу вместо файла книги. Скачивание отменено.');
    case 'djvu':
      throw new Error('DJVU: этот формат нельзя открыть в браузере. Выберите EPUB или PDF.');
    default:
      throw new Error('Неизвестный формат файла — разобрать его не получится.');
  }
}
