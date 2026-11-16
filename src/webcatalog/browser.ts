/**
 * InAppBrowser: открытие реального интернет-поиска и страниц сайтов.
 *
 * В APK используется нативный WebView (BrowserActivity) — там же
 * перехватываются загрузки файлов. В браузере (PWA) открываем новую
 * вкладку: поисковики запрещают встраивание в iframe, а парсить выдачу
 * нельзя по условиям сервисов.
 */
export interface PendingImport {
  id: string;
  name: string;
  mime?: string;
  size: number;
  /** 'download' — скачано во встроенном браузере, 'share' — из системного меню, 'picker' — SAF. */
  origin: 'download' | 'share' | 'picker';
}

interface PolkaNativeBridge {
  isNative?: () => boolean;
  openBrowser?: (url: string) => void;
  pickFile?: () => void;
  getPendingImports?: () => string;
  readImport?: (id: string) => string;
  clearPendingImports?: () => void;
  openExternal?: (url: string) => void;
  shareText?: (text: string) => void;
}

declare global {
  interface Window {
    PolkaNative?: PolkaNativeBridge;
    PolkaOnImport?: (json: string) => void;
  }
}

function bridge(): PolkaNativeBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.PolkaNative;
}

/** Запущено ли приложение внутри Android-оболочки (есть нативный мост). */
export function isNativeApp(): boolean {
  try {
    return Boolean(bridge()?.isNative?.());
  } catch {
    return false;
  }
}

/**
 * Открывает поиск/страницу. Возвращает true, если открыли во встроенном
 * браузере приложения, false — если ушли во внешнюю вкладку.
 */
export function openInAppBrowser(url: string, options: { external?: boolean } = {}): boolean {
  if (!url) return false;
  const native = bridge();
  if (native?.isNative?.()) {
    if (options.external) {
      native.openExternal?.(url);
      return true;
    }
    native.openBrowser?.(url);
    return true;
  }
  // PWA: поисковики не дают встраиваться в iframe — открываем вкладку.
  // Если браузер заблокировал окно, приложение остаётся на месте:
  // UI покажет ссылку «Открыть в браузере», по которой пользователь нажмёт сам.
  window.open(url, '_blank', 'noopener,noreferrer');
  return false;
}

/** Системный выбор файла (SAF) в APK. */
export function pickFileNative(): boolean {
  const native = bridge();
  if (!native?.isNative?.()) return false;
  native.pickFile?.();
  return true;
}

/** pending-импорты, подготовленные нативной частью (скачивание/шаринг/SAF). */
export function listPendingImports(): PendingImport[] {
  const native = bridge();
  if (!native?.getPendingImports) return [];
  try {
    const raw = native.getPendingImports();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingImport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Читает файл pending-импорта в байты. */
export function readPendingImport(id: string): Uint8Array | null {
  const native = bridge();
  if (!native?.readImport) return null;
  try {
    const base64 = native.readImport(id);
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function clearPendingImports(): void {
  bridge()?.clearPendingImports?.();
}

/**
 * Подписка на новые импорты от нативной части.
 * Нативный код вызывает `window.PolkaOnImport(JSON)` после скачивания
 * в браузере, шаринга или выбора файла; плюс раз в 2 секунды проверяем
 * очередь на случай, если событие потерялось.
 */
export function subscribeNativeImports(listener: (items: PendingImport[]) => void): () => void {
  if (!isNativeApp()) return () => undefined;
  let last = '';
  const check = () => {
    const items = listPendingImports();
    const signature = JSON.stringify(items.map((item) => item.id));
    if (items.length > 0 && signature !== last) {
      last = signature;
      listener(items);
    }
  };
  window.PolkaOnImport = () => check();
  const timer = window.setInterval(check, 2000);
  check();
  return () => {
    window.clearInterval(timer);
    if (timer) window.PolkaOnImport = undefined;
  };
}

/** Поделиться текстом/ссылкой (нативно или через Web Share API). */
export async function shareContent(payload: { title?: string; text?: string; url?: string }): Promise<boolean> {
  const native = bridge();
  if (native?.isNative?.() && native.shareText) {
    native.shareText([payload.title, payload.text, payload.url].filter(Boolean).join('\n'));
    return true;
  }
  if (navigator.share) {
    try {
      await navigator.share(payload);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
