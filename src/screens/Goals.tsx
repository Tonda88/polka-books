import { useMemo, useState } from 'react';import type { Goal, GoalMetric, GoalPeriod } from '../types';
import { useApp } from '../lib/store';
import {
  GOAL_PRESETS,
  PERIOD_TITLE,
  achievements,
  activityByDay,
  bestStreak,
  currentStreak,
  goalProgress,
  goalTitle,
  metricValueLabel,
  nextPresets,
  periodRange,
  todayTotals,
  type GoalPreset,
  type GoalProgress,
} from '../lib/goals';import { formatDateShort, formatMinutes, formatNumber, plural } from '../lib/format';
import { Ring } from '../components/Ring';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icons';
import { ProgressBar } from '../components/Progress';

const PERIOD_ORDER: GoalPeriod[] = ['week', 'month', 'year'];

const METRICS: Array<{ id: GoalMetric; label: string }> = [
  { id: 'books', label: 'Книги' },
  { id: 'pages', label: 'Страницы' },
  { id: 'minutes', label: 'Минуты' },
];

function defaultTarget(period: GoalPeriod, metric: GoalMetric): number {
  if (metric === 'books') return period === 'week' ? 1 : period === 'month' ? 2 : 12;
  if (metric === 'pages') return period === 'week' ? 150 : period === 'month' ? 600 : 6000;
  return period === 'week' ? 180 : period === 'month' ? 600 : 7200;
}

function stepFor(metric: GoalMetric): number {
  return metric === 'books' ? 1 : metric === 'pages' ? 20 : 20;
}

function maxTarget(metric: GoalMetric): number {
  return metric === 'books' ? 200 : 20_000;
}

export function GoalsScreen() {
  const { state, addGoal, updateGoal, deleteGoal, pushToast } = useApp();
  const [editor, setEditor] = useState<Goal | 'new' | null>(null);
  const now = Date.now();

  const today = todayTotals(state.sessions);
  const streak = currentStreak(state.sessions);
  const best = bestStreak(state.sessions);
  const cells = useMemo(() => activityByDay(state.sessions, 84), [state.sessions]);
  const badges = useMemo(() => achievements(state), [state]);
  const presets = nextPresets(state.goals);

  const goals = [...state.goals].sort(
    (a, b) => PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period) || a.createdAt - b.createdAt,
  );

  const weekRange = periodRange('week', now);
  const weekMinutes = state.sessions
    .filter((session) => session.ts >= weekRange.start && session.ts < weekRange.end)
    .reduce((sum, session) => sum + session.minutes, 0);

  const leading = cells.length > 0 ? (new Date(cells[0].ts).getDay() + 6) % 7 : 0;

  return (
    <div className="screen goals">
      <header className="page-head page-head--row">
        <div>
          <h1 className="page-title">Цели чтения</h1>
          <p className="page-sub">Неделя, месяц и год — прогресс считается автоматически</p>
        </div>
        <div className={`streak-badge ${streak > 0 ? 'is-hot' : ''}`}>
          <Icon name="flame" size={18} />
          <span>{streak}</span>
        </div>
      </header>

      <div className="stats-row">
        <div className="stat-tile">
          <strong>{Math.round(today.pages)}</strong>
          <span>{plural(Math.round(today.pages), 'страница', 'страницы', 'страниц')} сегодня</span>
        </div>
        <div className="stat-tile">
          <strong>{formatMinutes(today.minutes)}</strong>
          <span>сегодня с книгой</span>
        </div>
        <div className="stat-tile">
          <strong>{formatMinutes(weekMinutes)}</strong>
          <span>на этой неделе</span>
        </div>
      </div>

      <div className="section__head">
        <div>
          <h2 className="section__title">Ваши цели</h2>
          <p className="section__sub">
            {goals.length > 0
              ? `Серия ${streak} ${plural(streak, 'день', 'дня', 'дней')} · рекорд ${best}`
              : 'Поставьте первую цель — это мотивирует'}
          </p>
        </div>
        <button type="button" className="icon-button icon-button--accent" onClick={() => setEditor('new')} aria-label="Добавить цель">
          <Icon name="plus" size={20} />
        </button>
      </div>

      {goals.length > 0 ? (
        <div className="goal-list">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              progress={goalProgress(goal, state)}
              onEdit={() => setEditor(goal)}
              onDelete={() => deleteGoal(goal.id)}
            />
          ))}
          <button type="button" className="add-goal" onClick={() => setEditor('new')}>
            <Icon name="plus" size={18} />
            Добавить цель
          </button>
        </div>
      ) : (
        <div className="goal-suggestions">
          {presets.length > 0 ? (
            presets.slice(0, 4).map((preset) => (
              <button
                key={`${preset.period}-${preset.metric}`}
                type="button"
                className="suggestion-card"
                onClick={() => {
                  addGoal({ period: preset.period, metric: preset.metric, target: preset.target });
                }}
              >
                <span className="suggestion-card__period">{PERIOD_TITLE[preset.period]}</span>
                <strong>{preset.label}</strong>
                <span className="suggestion-card__action">
                  Поставить <Icon name="right" size={15} />
                </span>
              </button>
            ))
          ) : (
            <button type="button" className="add-goal" onClick={() => setEditor('new')}>
              <Icon name="plus" size={18} />
              Добавить цель
            </button>
          )}
        </div>
      )}

      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Активность</h2>
            <p className="section__sub">Последние 12 недель · страницы и прослушивание</p>
          </div>
        </div>
        <div className="heatmap-card">
          <div className="heatmap-grid">
            {Array.from({ length: leading }).map((_, index) => (
              <span key={`lead-${index}`} className="heatmap-cell is-empty" />
            ))}
            {cells.map((cell) => (
              <span
                key={cell.key}
                className={`heatmap-cell level-${cell.level}`}
                title={`${formatDateShort(cell.ts)}: ${Math.round(cell.pages)} стр., ${formatMinutes(cell.minutes)}`}
              />
            ))}
          </div>
          <div className="heatmap-legend">
            <span>меньше</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className={`heatmap-cell level-${level}`} />
            ))}
            <span>больше</span>
          </div>
          <div className="heatmap-summary">
            <span>
              <strong>{state.sessions.length}</strong> сессий чтения
            </span>
            <span>
              <strong>{formatNumber(Math.round(state.sessions.reduce((sum, session) => sum + session.pages, 0)))}</strong> страниц
            </span>
            <span>
              <strong>{formatMinutes(state.sessions.reduce((sum, session) => sum + session.minutes, 0))}</strong> с книгой
            </span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <div>
            <h2 className="section__title">Достижения</h2>
            <p className="section__sub">Открываются по мере чтения</p>
          </div>
        </div>
        <div className="badge-grid">
          {badges.map((badge) => (
            <div key={badge.id} className={`badge-card ${badge.unlocked ? 'is-unlocked' : ''}`}>
              <span className="badge-card__icon">{badge.icon}</span>
              <div className="badge-card__body">
                <strong>{badge.title}</strong>
                <span>{badge.description}</span>
                {!badge.unlocked && badge.target > 1 && (
                  <ProgressBar value={(badge.progress / badge.target) * 100} height={4} />
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <p className="goals-note">
        Страницы считаются по прочитанному тексту, минуты — по времени в читалке и плеере. Прослушивание тоже
        засчитывается в цели.
      </p>

      <Sheet
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor === 'new' || editor === null ? 'Новая цель' : 'Изменить цель'}
        subtitle="Прогресс считается сам — читайте и слушайте"
      >
        {editor !== null && (
          <GoalForm
            initial={editor === 'new' ? undefined : editor}
            onCancel={() => setEditor(null)}
            onSave={(draft) => {
              if (editor !== 'new') {
                updateGoal(editor.id, draft);
                pushToast('Цель обновлена', 'success');
              } else {
                addGoal(draft);
              }
              setEditor(null);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function GoalCard({
  progress,
  onEdit,
  onDelete,
}: {
  progress: GoalProgress;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { goal } = progress;
  const color =
    progress.status === 'done'
      ? 'var(--green)'
      : progress.status === 'behind'
        ? 'var(--red)'
        : progress.status === 'ahead'
          ? 'var(--accent-2)'
          : 'var(--accent)';

  return (
    <article className="goal-card">
      <div className="goal-card__main">
        <Ring percent={progress.percent} size={74} stroke={7} color={color}>
          <span className="ring__value-text">{Math.round(progress.percent)}%</span>
        </Ring>
        <div className="goal-card__body">
          <div className="goal-card__top">
            <div>
              <div className="goal-card__period">{PERIOD_TITLE[goal.period]}</div>
              <div className="goal-card__title">{goalTitle(goal)}</div>
            </div>
            <div className="goal-card__actions">
              <button type="button" className="icon-button icon-button--sm" onClick={onEdit} aria-label="Изменить цель">
                <Icon name="pencil" size={15} />
              </button>
              <button
                type="button"
                className="icon-button icon-button--sm"
                onClick={onDelete}
                aria-label="Удалить цель"
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
          <div className="goal-card__numbers">
            <strong>{metricValueLabel(progress.current, goal.metric)}</strong>
            <span>из {metricValueLabel(progress.target, goal.metric)}</span>
          </div>
          <ProgressBar value={progress.percent} height={6} color={color} />
          <div className="goal-card__meta">
            <span className={`status-chip status-chip--${progress.status}`}>{progress.statusLabel}</span>
            <span>
              {progress.daysLeft > 0
                ? `${progress.daysLeft} ${plural(progress.daysLeft, 'день', 'дня', 'дней')} до конца`
                : 'последний день'}
            </span>
          </div>
          <p className="goal-card__hint">{progress.hint}</p>
        </div>
      </div>
    </article>
  );
}

function GoalForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Goal;
  onSave: (draft: { period: GoalPeriod; metric: GoalMetric; target: number }) => void;
  onCancel: () => void;
}) {
  const [period, setPeriod] = useState<GoalPeriod>(initial?.period ?? 'week');
  const [metric, setMetric] = useState<GoalMetric>(initial?.metric ?? 'pages');
  const [target, setTarget] = useState<number>(initial?.target ?? defaultTarget('week', 'pages'));

  const changePeriod = (nextPeriod: GoalPeriod) => {
    setPeriod(nextPeriod);
    if (!initial) setTarget(defaultTarget(nextPeriod, metric));
  };
  const changeMetric = (nextMetric: GoalMetric) => {
    setMetric(nextMetric);
    if (!initial) setTarget(defaultTarget(period, nextMetric));
  };

  const presetsForMetric = GOAL_PRESETS.filter((preset: GoalPreset) => preset.metric === metric);

  return (
    <div className="goal-form">
      <div className="field">
        <span className="field__label">Период</span>
        <div className="segmented">
          {(['week', 'month', 'year'] as GoalPeriod[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`segmented__item ${period === item ? 'is-active' : ''}`}
              onClick={() => changePeriod(item)}
            >
              {item === 'week' ? 'Неделя' : item === 'month' ? 'Месяц' : 'Год'}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Что считаем</span>
        <div className="segmented">
          {METRICS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segmented__item ${metric === item.id ? 'is-active' : ''}`}
              onClick={() => changeMetric(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field__label">Цель — {goalTitle({ period, metric, target })}</span>
        <div className="target-control">
          <button
            type="button"
            className="target-step"
            onClick={() => setTarget((value) => Math.max(1, value - stepFor(metric)))}
            aria-label="Уменьшить цель"
          >
            −
          </button>
          <input
            className="target-input"
            type="number"
            min={1}
            max={maxTarget(metric)}
            value={target}
            onChange={(event) => {
              const value = Number(event.target.value);
              setTarget(Number.isFinite(value) ? Math.min(maxTarget(metric), Math.max(1, value)) : 1);
            }}
            aria-label="Значение цели"
          />
          <button
            type="button"
            className="target-step"
            onClick={() => setTarget((value) => Math.min(maxTarget(metric), value + stepFor(metric)))}
            aria-label="Увеличить цель"
          >
            +
          </button>
        </div>
        <input
          className="range"
          type="range"
          min={1}
          max={metric === 'books' ? 60 : metric === 'pages' ? 3000 : 3000}
          step={stepFor(metric)}
          value={Math.min(metric === 'books' ? 60 : 3000, target)}
          onChange={(event) => setTarget(Number(event.target.value))}
          aria-label="Диапазон цели"
        />
      </div>

      {presetsForMetric.length > 0 && (
        <div className="preset-row">
          {presetsForMetric.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="chip"
              onClick={() => {
                setPeriod(preset.period);
                setTarget(preset.target);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      <div className="sheet-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Отмена
        </button>
        <button type="button" className="btn btn--primary" onClick={() => onSave({ period, metric, target })}>
          {initial ? 'Сохранить' : 'Поставить цель'}
        </button>
      </div>
    </div>
  );
}

export function GoalsScreenPlaceholder() {
  return null;
}
