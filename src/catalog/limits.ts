/**
 * Защита от лимитов и падений отдельных источников.
 *
 *  - минимальный интервал между запросами к одному источнику (rate limit);
 *  - «предохранитель» (circuit breaker): после нескольких ошибок подряд
 *    источник временно не опрашивается, чтобы поиск не ждал таймаутов;
 *  - счётчики для статуса «источник деградировал».
 *
 * Модуль не бросает исключений и не блокирует приложение: если источник
 * в отпуске, поиск просто идёт по остальным.
 */

interface SourceState {
  lastRequestAt: number;
  failures: number;
  lastFailureAt: number;
  circuitUntil: number;
  totalRequests: number;
  totalFailures: number;
}

const state = new Map<string, SourceState>();

/** Минимальный интервал между запросами к источнику, мс. */
const MIN_INTERVAL: Record<string, number> = {
  openlibrary: 120,
  archive: 200,
  gutenberg: 200,
  librivox: 200,
  googlebooks: 100,
  local: 0,
};

/** Сколько ошибок подряд открывают предохранитель. */
const FAILURE_THRESHOLD = 3;
/** Пауза для источника после серии ошибок, мс. */
const CIRCUIT_COOLDOWN = 60_000;

function stateOf(sourceId: string): SourceState {
  let entry = state.get(sourceId);
  if (!entry) {
    entry = {
      lastRequestAt: 0,
      failures: 0,
      lastFailureAt: 0,
      circuitUntil: 0,
      totalRequests: 0,
      totalFailures: 0,
    };
    state.set(sourceId, entry);
  }
  return entry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Открыт ли предохранитель (источник временно пропускается). */
export function isCircuitOpen(sourceId: string): boolean {
  const entry = stateOf(sourceId);
  if (!entry.circuitUntil) return false;
  if (Date.now() >= entry.circuitUntil) {
    entry.circuitUntil = 0;
    entry.failures = 0;
    return false;
  }
  return true;
}

/** Сколько секунд осталось до повторной попытки. */
export function circuitRemainingMs(sourceId: string): number {
  const entry = stateOf(sourceId);
  return Math.max(0, entry.circuitUntil - Date.now());
}

export interface GuardOptions {
  /** Отключить паузу (например, для health-check). */
  skipDelay?: boolean;
}

/**
 * Выполняет запрос к источнику с учётом лимитов.
 * Если предохранитель открыт — возвращает `null` (источник пропущен),
 * не выполняя сетевой запрос.
 */
export async function withSourceGuard<T>(
  sourceId: string,
  task: () => Promise<T>,
  options: GuardOptions = {},
): Promise<T | null> {
  const entry = stateOf(sourceId);
  if (isCircuitOpen(sourceId)) return null;

  const interval = MIN_INTERVAL[sourceId] ?? 150;
  if (!options.skipDelay && interval > 0) {
    const wait = entry.lastRequestAt + interval - Date.now();
    if (wait > 0) await sleep(Math.min(wait, interval));
  }
  entry.lastRequestAt = Date.now();
  entry.totalRequests += 1;

  try {
    const result = await task();
    entry.failures = 0;
    return result;
  } catch (error) {
    entry.failures += 1;
    entry.totalFailures += 1;
    entry.lastFailureAt = Date.now();
    if (entry.failures >= FAILURE_THRESHOLD) {
      entry.circuitUntil = Date.now() + CIRCUIT_COOLDOWN;
    }
    throw error;
  }
}

export interface SourceBudget {
  sourceId: string;
  requests: number;
  failures: number;
  circuitOpen: boolean;
  remainingMs: number;
}

/** Текущее состояние всех источников — для отладки и статуса в UI. */
export function sourceBudgets(): SourceBudget[] {
  return [...state.entries()].map(([sourceId, entry]) => ({
    sourceId,
    requests: entry.totalRequests,
    failures: entry.totalFailures,
    circuitOpen: isCircuitOpen(sourceId),
    remainingMs: circuitRemainingMs(sourceId),
  }));
}

/** Ручной сброс предохранителя (кнопка «Проверить источники»). */
export function resetSourceGuard(sourceId?: string): void {
  if (sourceId) {
    const entry = stateOf(sourceId);
    entry.failures = 0;
    entry.circuitUntil = 0;
    return;
  }
  for (const entry of state.values()) {
    entry.failures = 0;
    entry.circuitUntil = 0;
  }
}
