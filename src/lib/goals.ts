import type { AppState, Goal, GoalMetric, GoalPeriod, ReadingSession } from '../types';
import { dayKey, plural } from './format';

export interface Range {
  start: number;
  end: number;
}

export const PERIOD_LABEL: Record<GoalPeriod, string> = {
  week: 'неделя',
  month: 'месяц',
  year: 'год',
};

export const PERIOD_TITLE: Record<GoalPeriod, string> = {
  week: 'Недельная цель',
  month: 'Цель месяца',
  year: 'Годовая цель',
};

export const PERIOD_SHORT: Record<GoalPeriod, string> = {
  week: 'неделю',
  month: 'месяц',
  year: 'год',
};

export const METRIC_LABEL: Record<GoalMetric, string> = {
  books: 'книги',
  pages: 'страницы',
  minutes: 'минуты',
};

export function metricWord(value: number, metric: GoalMetric): string {
  if (metric === 'books') return plural(value, 'книга', 'книги', 'книг');
  if (metric === 'pages') return plural(value, 'страница', 'страницы', 'страниц');
  return plural(value, 'минута', 'минуты', 'минут');
}

export function goalTitle(goal: Pick<Goal, 'period' | 'metric' | 'target'>): string {
  const value = Math.round(goal.target);
  const word = metricWord(value, goal.metric);
  const period = PERIOD_SHORT[goal.period];
  return `${value} ${word} в ${period}`;
}

export function metricValueLabel(value: number, metric: GoalMetric): string {
  if (metric === 'books') return `${Math.round(value)} ${metricWord(value, metric)}`;
  if (metric === 'pages') return `${Math.round(value)} стр.`;
  return `${Math.round(value)} мин`;
}

export function periodRange(period: GoalPeriod, now = Date.now()): Range {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (period === 'week') {
    const weekday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - weekday);
    const start = date.getTime();
    const end = new Date(date);
    end.setDate(end.getDate() + 7);
    return { start, end: end.getTime() };
  }
  if (period === 'month') {
    date.setDate(1);
    const start = date.getTime();
    const end = new Date(date);
    end.setMonth(end.getMonth() + 1);
    return { start, end: end.getTime() };
  }
  date.setMonth(0, 1);
  const start = date.getTime();
  const end = new Date(date);
  end.setFullYear(end.getFullYear() + 1);
  return { start, end: end.getTime() };
}

export function sessionsInRange(sessions: ReadingSession[], range: Range): ReadingSession[] {
  return sessions.filter((session) => session.ts >= range.start && session.ts < range.end);
}

export function minutesInRange(sessions: ReadingSession[], range: Range): number {
  return sessionsInRange(sessions, range).reduce((sum, session) => sum + session.minutes, 0);
}

export function pagesInRange(sessions: ReadingSession[], range: Range): number {
  return sessionsInRange(sessions, range).reduce((sum, session) => sum + session.pages, 0);
}

export function booksFinishedInRange(state: AppState, range: Range): number {
  return Object.values(state.progress).filter(
    (entry) => entry.finishedAt && entry.finishedAt >= range.start && entry.finishedAt < range.end,
  ).length;
}

export function goalCurrent(goal: Goal, state: AppState, now = Date.now()): number {
  const range = periodRange(goal.period, now);
  if (goal.metric === 'books') return booksFinishedInRange(state, range);
  if (goal.metric === 'pages') return pagesInRange(state.sessions, range);
  return minutesInRange(state.sessions, range);
}

export type GoalStatus = 'done' | 'ahead' | 'on-track' | 'behind' | 'empty';

export interface GoalProgress {
  goal: Goal;
  current: number;
  target: number;
  percent: number;
  expectedPercent: number;
  status: GoalStatus;
  statusLabel: string;
  range: Range;
  daysLeft: number;
  perDay: number;
  projected: number | null;
  hint: string;
}

export function goalProgress(goal: Goal, state: AppState, now = Date.now()): GoalProgress {
  const range = periodRange(goal.period, now);
  const current = goalCurrent(goal, state, now);
  const target = Math.max(1, goal.target);
  const percent = Math.min(100, (current / target) * 100);
  const elapsedFraction = Math.min(1, Math.max(0, (now - range.start) / (range.end - range.start)));
  const expectedPercent = elapsedFraction * 100;
  const daysLeft = Math.max(0, Math.ceil((range.end - now) / 86_400_000));
  const perDay = daysLeft > 0 ? Math.max(0, (target - current) / daysLeft) : Math.max(0, target - current);
  const projected = elapsedFraction > 0.04 ? Math.round(current / elapsedFraction) : null;

  let status: GoalStatus;
  if (current >= target) status = 'done';
  else if (current === 0 && elapsedFraction > 0.15) status = 'behind';
  else if (percent - expectedPercent >= 8) status = 'ahead';
  else if (percent - expectedPercent <= -8) status = 'behind';
  else status = 'on-track';

  let statusLabel: string;
  if (status === 'done') statusLabel = 'Цель достигнута';
  else if (status === 'ahead') statusLabel = 'Вы впереди плана';
  else if (status === 'on-track') statusLabel = 'В графике';
  else statusLabel = 'Нужно ускориться';

  let hint: string;
  if (status === 'done') {
    hint = 'Можно поднять планку — вы справились досрочно.';
  } else if (daysLeft === 0) {
    hint = 'Последний день периода — ещё есть шанс успеть.';
  } else if (goal.metric === 'books') {
    hint = `Осталось ${Math.ceil(target - current)} ${metricWord(Math.ceil(target - current), 'books')} за ${daysLeft} ${plural(daysLeft, 'день', 'дня', 'дней')}.`;
  } else if (goal.metric === 'minutes') {
    hint = `По ${Math.round(perDay)} мин в день — и цель закрыта.`;
  } else {
    hint = `По ${Math.round(perDay)} стр. в день — и цель закрыта.`;
  }

  return {
    goal,
    current,
    target,
    percent,
    expectedPercent,
    status,
    statusLabel,
    range,
    daysLeft,
    perDay,
    projected,
    hint,
  };
}

export interface DayCell {
  key: string;
  ts: number;
  pages: number;
  minutes: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export function activityByDay(sessions: ReadingSession[], days = 84, now = Date.now()): DayCell[] {
  const byDay = new Map<string, { pages: number; minutes: number; ts: number }>();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - offset);
    const key = dayKey(date.getTime());
    byDay.set(key, { pages: 0, minutes: 0, ts: date.getTime() });
  }
  for (const session of sessions) {
    const cell = byDay.get(session.date);
    if (!cell) continue;
    cell.pages += session.pages;
    cell.minutes += session.minutes;
  }
  return [...byDay.entries()].map(([key, value]) => {
    const activity = value.pages + value.minutes * 0.6;
    const level: DayCell['level'] =
      activity <= 0 ? 0 : activity < 8 ? 1 : activity < 20 ? 2 : activity < 40 ? 3 : 4;
    return { key, ts: value.ts, pages: value.pages, minutes: value.minutes, level };
  });
}

export function currentStreak(sessions: ReadingSession[], now = Date.now()): number {
  const active = new Set(sessions.filter((s) => s.pages > 0 || s.minutes > 0).map((s) => s.date));
  if (active.size === 0) return 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  let streak = 0;
  // Сегодня может быть ещё не отмечен — тогда считаем со вчерашнего дня.
  if (!active.has(dayKey(cursor.getTime()))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!active.has(dayKey(cursor.getTime()))) return 0;
  }
  for (;;) {
    if (!active.has(dayKey(cursor.getTime()))) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function bestStreak(sessions: ReadingSession[]): number {
  const days = [...new Set(sessions.filter((s) => s.pages > 0 || s.minutes > 0).map((s) => s.date))].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const key of days) {
    const [y, m, d] = key.split('-').map(Number);
    const ts = new Date(y, m - 1, d).getTime();
    run = previous !== null && ts - previous === 86_400_000 ? run + 1 : 1;
    previous = ts;
    if (run > best) best = run;
  }
  return best;
}

export function todayTotals(sessions: ReadingSession[], now = Date.now()): { pages: number; minutes: number } {
  const key = dayKey(now);
  return sessions
    .filter((session) => session.date === key)
    .reduce(
      (acc, session) => ({ pages: acc.pages + session.pages, minutes: acc.minutes + session.minutes }),
      { pages: 0, minutes: 0 },
    );
}

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  description: string;
  unlocked: boolean;
  progress: number;
  target: number;
}

export function achievements(state: AppState): Achievement[] {
  const finished = Object.values(state.progress).filter((entry) => entry.finishedAt).length;
  const totalPages = state.sessions.reduce((sum, session) => sum + session.pages, 0);
  const totalMinutes = state.sessions.reduce((sum, session) => sum + session.minutes, 0);
  const streak = currentStreak(state.sessions);
  const items: Achievement[] = [
    {
      id: 'first-book',
      icon: '📖',
      title: 'Первая книга',
      description: 'Дочитайте книгу до конца',
      unlocked: finished >= 1,
      progress: Math.min(1, finished),
      target: 1,
    },
    {
      id: 'five-books',
      icon: '📚',
      title: 'Книжный червь',
      description: 'Дочитайте 5 книг',
      unlocked: finished >= 5,
      progress: Math.min(5, finished),
      target: 5,
    },
    {
      id: 'streak-7',
      icon: '🔥',
      title: 'Неделя подряд',
      description: '7 дней чтения без пропусков',
      unlocked: streak >= 7,
      progress: Math.min(7, streak),
      target: 7,
    },
    {
      id: 'pages-1000',
      icon: '🗺️',
      title: 'Тысяча страниц',
      description: 'Прочитайте 1000 страниц',
      unlocked: totalPages >= 1000,
      progress: Math.min(1000, Math.round(totalPages)),
      target: 1000,
    },
    {
      id: 'hours-10',
      icon: '🎧',
      title: '10 часов с книгой',
      description: 'Читайте и слушайте 10 часов',
      unlocked: totalMinutes >= 600,
      progress: Math.min(600, Math.round(totalMinutes)),
      target: 600,
    },
    {
      id: 'marathon',
      icon: '⚡',
      title: 'Марафонец',
      description: '100 минут за один день',
      unlocked: Object.values(
        state.sessions.reduce<Record<string, number>>((acc, session) => {
          acc[session.date] = (acc[session.date] ?? 0) + session.minutes;
          return acc;
        }, {}),
      ).some((minutes) => minutes >= 100),
      progress: 0,
      target: 100,
    },
  ];
  return items;
}

export interface GoalPreset {
  label: string;
  period: GoalPeriod;
  metric: GoalMetric;
  target: number;
}

export const GOAL_PRESETS: GoalPreset[] = [
  { label: 'Книга в месяц', period: 'month', metric: 'books', target: 1 },
  { label: '12 книг за год', period: 'year', metric: 'books', target: 12 },
  { label: '50 страниц в неделю', period: 'week', metric: 'pages', target: 50 },
  { label: '20 минут в день', period: 'week', metric: 'minutes', target: 140 },
  { label: '900 страниц в месяц', period: 'month', metric: 'pages', target: 900 },
];

export function nextPresets(goals: Goal[]): GoalPreset[] {
  return GOAL_PRESETS.filter(
    (preset) => !goals.some((goal) => goal.period === preset.period && goal.metric === preset.metric),
  );
}

export function totalStats(state: AppState): { pages: number; minutes: number; finished: number; sessions: number } {
  return {
    pages: Math.round(state.sessions.reduce((sum, session) => sum + session.pages, 0)),
    minutes: Math.round(state.sessions.reduce((sum, session) => sum + session.minutes, 0)),
    finished: Object.values(state.progress).filter((entry) => entry.finishedAt).length,
    sessions: state.sessions.length,
  };
}
