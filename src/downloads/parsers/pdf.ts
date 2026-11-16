/**
 * PDF: валидация и извлечение метаданных (без полного разбора текста).
 *
 * Полноценный парсинг PDF (шрифты, кодировки, content streams) — отдельная
 * большая задача. Здесь мы проверяем, что файл действительно PDF и не обрезан,
 * и вытаскиваем /Count из /Pages, /Title и /Author простой эвристикой.
 */
export interface PdfInfo {
  pages?: number;
  title?: string;
  author?: string;
}

// --------------------------------------------------------------------------- //
// Поиск по байтам
// --------------------------------------------------------------------------- //

function indexOfAscii(bytes: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  const last = bytes.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (bytes[i] !== first) continue;
    let match = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function indexOfLastAscii(bytes: Uint8Array, needle: string): number {
  const first = needle.charCodeAt(0);
  for (let i = bytes.length - needle.length; i >= 0; i -= 1) {
    if (bytes[i] !== first) continue;
    let match = true;
    for (let j = 1; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
}

function skipWhitespace(bytes: Uint8Array, from: number): number {
  let index = from;
  while (index < bytes.length && isWhitespace(bytes[index])) index += 1;
  return index;
}

// --------------------------------------------------------------------------- //
// Строки PDF
// --------------------------------------------------------------------------- //

function decodeClean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function decodePdfString(raw: Uint8Array): string {
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    return decodeClean(new TextDecoder('utf-16be').decode(raw.subarray(2)));
  }
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    return decodeClean(new TextDecoder('utf-16le').decode(raw.subarray(2)));
  }
  try {
    return decodeClean(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    // PDFDocEncoding близок к Latin-1, но русские PDF часто пишут /Title в cp1251.
    return decodeClean(new TextDecoder('windows-1251').decode(raw));
  }
}

function readLiteralString(bytes: Uint8Array, start: number): { value: Uint8Array; end: number } | null {
  if (bytes[start] !== 0x28) return null;
  const out: number[] = [];
  let depth = 1;
  let index = start + 1;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === 0x5c) {
      const next = bytes[index + 1];
      if (next === undefined) return null;
      if (next === 0x6e) {
        out.push(0x0a);
        index += 2;
      } else if (next === 0x72) {
        out.push(0x0d);
        index += 2;
      } else if (next === 0x74) {
        out.push(0x09);
        index += 2;
      } else if (next === 0x62) {
        out.push(0x08);
        index += 2;
      } else if (next === 0x66) {
        out.push(0x0c);
        index += 2;
      } else if (next === 0x28 || next === 0x29 || next === 0x5c) {
        out.push(next);
        index += 2;
      } else if (next >= 0x30 && next <= 0x37) {
        let octal = '';
        let cursor = index + 1;
        while (cursor < bytes.length && cursor < index + 4 && bytes[cursor] >= 0x30 && bytes[cursor] <= 0x37) {
          octal += String.fromCharCode(bytes[cursor]);
          cursor += 1;
        }
        out.push(Number.parseInt(octal, 8) & 0xff);
        index = cursor;
      } else if (next === 0x0a) {
        index += 2;
      } else if (next === 0x0d) {
        index += bytes[index + 2] === 0x0a ? 3 : 2;
      } else {
        out.push(next);
        index += 2;
      }
      continue;
    }
    if (byte === 0x28) {
      depth += 1;
      out.push(byte);
      index += 1;
      continue;
    }
    if (byte === 0x29) {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      out.push(byte);
      continue;
    }
    if (byte === 0x0d) {
      out.push(0x0a);
      index += bytes[index + 1] === 0x0a ? 2 : 1;
      continue;
    }
    out.push(byte);
    index += 1;
  }
  if (depth !== 0) return null;
  return { value: new Uint8Array(out), end: index };
}

function readHexString(bytes: Uint8Array, start: number): { value: Uint8Array; end: number } | null {
  if (bytes[start] !== 0x3c || bytes[start + 1] === 0x3c) return null;
  let index = start + 1;
  let hex = '';
  while (index < bytes.length && bytes[index] !== 0x3e) {
    const byte = bytes[index];
    if (!isWhitespace(byte)) {
      hex += String.fromCharCode(byte);
    }
    index += 1;
  }
  if (index >= bytes.length) return null;
  index += 1;
  if (hex.length % 2 === 1) hex += '0';
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const value = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(value)) return null;
    out[i] = value;
  }
  return { value: out, end: index };
}

/** Ищет /Title или /Author по всему файлу и декодирует первое строковое значение. */
function readInfoField(bytes: Uint8Array, key: string): string | undefined {
  let from = 0;
  for (;;) {
    const position = indexOfAscii(bytes, key, from);
    if (position < 0) return undefined;
    const valueStart = skipWhitespace(bytes, position + key.length);
    const parsed =
      bytes[valueStart] === 0x28
        ? readLiteralString(bytes, valueStart)
        : bytes[valueStart] === 0x3c
          ? readHexString(bytes, valueStart)
          : null;
    if (parsed) {
      const value = decodePdfString(parsed.value);
      if (value) return value;
    }
    from = position + key.length;
  }
}

// --------------------------------------------------------------------------- //
// Структура
// --------------------------------------------------------------------------- //

function findPageCount(bytes: Uint8Array): number | undefined {
  let best: number | undefined;
  let from = 0;
  for (;;) {
    const position = indexOfAscii(bytes, '/Count', from);
    if (position < 0) break;
    let index = skipWhitespace(bytes, position + '/Count'.length);
    let digits = '';
    while (index < bytes.length && bytes[index] >= 0x30 && bytes[index] <= 0x39) {
      digits += String.fromCharCode(bytes[index]);
      index += 1;
    }
    if (digits) {
      const value = Number.parseInt(digits, 10);
      if (Number.isFinite(value) && value > 0 && value < 1_000_000) {
        best = best === undefined ? value : Math.max(best, value);
      }
    }
    from = position + '/Count'.length;
  }
  return best;
}

/**
 * Проверяет PDF и извлекает метаданные. Бросает понятную ошибку, если файл
 * повреждён или не является PDF.
 */
export async function parsePdfInfo(buffer: ArrayBuffer): Promise<PdfInfo> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16) throw new Error('PDF повреждён: файл слишком мал для документа PDF.');
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    throw new Error('PDF: файл не начинается с сигнатуры %PDF.');
  }

  const hasObject = indexOfAscii(bytes, ' obj') >= 0 || indexOfAscii(bytes, '\nobj') >= 0;
  if (!hasObject) throw new Error('PDF повреждён: в документе не найдено ни одного объекта.');

  const eof = indexOfLastAscii(bytes, '%%EOF');
  if (eof < 0 || bytes.length - eof > 2048) {
    throw new Error('PDF повреждён: не найден маркер завершения %%EOF — похоже, файл скачан не полностью.');
  }

  const info: PdfInfo = {};
  const pages = findPageCount(bytes);
  if (pages !== undefined) info.pages = pages;
  const title = readInfoField(bytes, '/Title');
  if (title) info.title = title;
  const author = readInfoField(bytes, '/Author');
  if (author) info.author = author;
  return info;
}
