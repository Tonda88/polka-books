export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function pct(value: number, total: number): number {
  if (!total) return 0;
  return clamp((value / total) * 100, 0, 100);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.round(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}

/** 74 -> "1 ч 14 мин", 40 -> "40 мин", 8 -> "8 мин" */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

export function formatMinutesShort(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}м`;
  return m === 0 ? `${h}ч` : `${h}ч ${m}м`;
}

export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export function formatDateShort(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

export function formatWeekday(ts: number): string {
  return new Date(ts).toLocaleDateString('ru-RU', { weekday: 'long' });
}

export function weekdayShort(index: number): string {
  return ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][index] ?? '';
}

export function greeting(hour = new Date().getHours()): string {
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18 && hour < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'только что';
  if (diff < hour) return `${Math.floor(diff / minute)} мин назад`;
  if (diff < day) return `${Math.floor(diff / hour)} ч назад`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} дн назад`;
  return formatDate(ts);
}

export function shortText(text: string, limit = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}…`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'П';
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function hashCode(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function formatPaceDays(days: number): string {
  if (days <= 0) return 'последний день';
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
