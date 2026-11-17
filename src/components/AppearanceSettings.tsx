import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { ACCENT_SWATCHES, applyAppearance, THEMES } from '../design/appearance';
import type { Settings } from '../types';
import type { AccentId } from '../design/appearance';

const CARD_STYLES: Array<{ id: NonNullable<Settings['cardStyle']>; label: string; hint: string }> = [
  { id: 'cover', label: 'Обложки', hint: 'Крупнее изображение' },
  { id: 'comfortable', label: 'Удобно', hint: 'Больше воздуха' },
  { id: 'minimal', label: 'Компактно', hint: 'Больше книг на экране' },
];
const DENSITIES: Array<{ id: NonNullable<Settings['uiDensity']>; label: string }> = [
  { id: 'compact', label: 'Плотно' },
  { id: 'comfortable', label: 'Обычно' },
  { id: 'spacious', label: 'Свободно' },
];

/** Настройки внешнего вида с живым preview на всём приложении. */
export function AppearanceSettings() {
  const { state, updateSettings, pushToast } = useApp();
  const settings = state.settings;
  const [previewTheme, setPreviewTheme] = useState(settings.appearanceTheme ?? 'graphite');
  const [previewMode, setPreviewMode] = useState(settings.appearanceMode ?? 'system');

  useEffect(() => {
    setPreviewTheme(settings.appearanceTheme ?? 'graphite');
    setPreviewMode(settings.appearanceMode ?? 'system');
  }, [settings.appearanceTheme, settings.appearanceMode]);

  const update = (patch: Partial<Settings>) => {
    const next = {
      ...settings,
      ...patch,
      appearanceTheme: previewTheme,
      appearanceMode: previewMode,
    };
    updateSettings({ ...patch, appearanceTheme: previewTheme, appearanceMode: previewMode });
    applyAppearance(document.documentElement, next);
  };

  const preview = (theme: typeof previewTheme, mode = previewMode) => {
    setPreviewTheme(theme);
    setPreviewMode(mode);
    applyAppearance(document.documentElement, { ...settings, appearanceTheme: theme, appearanceMode: mode });
  };

  const savePreview = () => {
    updateSettings({ appearanceTheme: previewTheme, appearanceMode: previewMode });
    pushToast(`Оформление «${THEMES.find((theme) => theme.id === previewTheme)?.name}» сохранено`, 'success');
  };

  const discardPreview = () => {
    setPreviewTheme(settings.appearanceTheme ?? 'graphite');
    setPreviewMode(settings.appearanceMode ?? 'system');
    applyAppearance(document.documentElement, settings);
  };

  const hasPreviewChanges =
    previewTheme !== (settings.appearanceTheme ?? 'graphite') || previewMode !== (settings.appearanceMode ?? 'system');

  return (
    <section className="appearance-settings" aria-label="Внешний вид">
      <div className="appearance-section-head">
        <div>
          <h2 className="section__title">Внешний вид</h2>
          <p className="section__sub">Настройте «Полку» под себя — изменения видны сразу</p>
        </div>
      </div>

      <div className="appearance-mode" role="group" aria-label="Светлая или тёмная тема">
        {([
          ['system', 'Как в системе'],
          ['dark', 'Тёмная'],
          ['light', 'Светлая'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`appearance-mode__item ${previewMode === id ? 'is-active' : ''}`}
            onClick={() => preview(previewTheme, id)}
            aria-pressed={previewMode === id}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="appearance-themes" role="radiogroup" aria-label="Готовые темы">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={`appearance-theme ${previewTheme === theme.id ? 'is-selected' : ''}`}
            onClick={() => preview(theme.id)}
            role="radio"
            aria-checked={previewTheme === theme.id}
            aria-label={`Тема ${theme.name}`}
          >
            <span className="appearance-theme__swatches">
              {[theme.colors.bg, theme.colors.surface, theme.colors.accent, theme.colors.accent2].map((color) => (
                <span key={color} style={{ background: color }} />
              ))}
            </span>
            <span className="appearance-theme__name">{theme.name}</span>
            <span className="appearance-theme__hint">{theme.description}</span>
          </button>
        ))}
      </div>

      <div className="appearance-setting">
        <div className="appearance-setting__head">
          <strong>Акцентный цвет</strong>
          <span>{ACCENT_SWATCHES.find((item) => item.id === settings.accentColor)?.name ?? 'Олива'}</span>
        </div>
        <div className="appearance-swatches" role="radiogroup" aria-label="Акцентный цвет">
          {ACCENT_SWATCHES.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              className={`appearance-swatch ${settings.accentColor === swatch.id ? 'is-selected' : ''}`}
              style={{ background: swatch.value }}
              onClick={() => update({ accentColor: swatch.id as AccentId })}
              aria-label={swatch.name}
              aria-checked={settings.accentColor === swatch.id}
              role="radio"
            />
          ))}
        </div>
      </div>

      <div className="appearance-setting">
        <div className="appearance-setting__head">
          <strong>Размер текста</strong>
          <span>{Math.round((settings.uiFontScale ?? 1) * 100)}%</span>
        </div>
        <input
          className="range"
          type="range"
          min={0.9}
          max={1.2}
          step={0.05}
          value={settings.uiFontScale ?? 1}
          onChange={(event) => update({ uiFontScale: Number(event.target.value) })}
          aria-label="Размер текста интерфейса"
        />
      </div>

      <div className="appearance-setting">
        <div className="appearance-setting__head">
          <strong>Плотность интерфейса</strong>
        </div>
        <div className="appearance-segmented">
          {DENSITIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={(settings.uiDensity ?? 'comfortable') === item.id ? 'is-active' : ''}
              onClick={() => update({ uiDensity: item.id })}
              aria-pressed={(settings.uiDensity ?? 'comfortable') === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-setting">
        <div className="appearance-setting__head">
          <strong>Карточки книг</strong>
        </div>
        <div className="appearance-card-styles">
          {CARD_STYLES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`appearance-card-style ${settings.cardStyle === item.id ? 'is-active' : ''}`}
              onClick={() => update({ cardStyle: item.id })}
              aria-pressed={settings.cardStyle === item.id}
            >
              <span className={`appearance-card-style__sample appearance-card-style__sample--${item.id}`}>
                <i />
                <i />
                <i />
              </span>
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="appearance-setting appearance-setting--row">
        <div>
          <strong>Анимации</strong>
          <small>Умеренные переходы и нажатия</small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.animations !== false}
          className={`switch ${settings.animations !== false ? 'is-on' : ''}`}
          onClick={() => update({ animations: settings.animations === false })}
        >
          <span className="switch__thumb" />
        </button>
      </div>

      {(
        <div className="appearance-preview-actions">
          <span>{hasPreviewChanges ? 'Предпросмотр активен во всём приложении' : 'Оформление применено ко всем экранам'}</span>
          <div>
            <button type="button" className="mini-button" onClick={discardPreview}>Отменить</button>
            <button type="button" className="mini-button mini-button--accent" onClick={savePreview}>Применить тему</button>
          </div>
        </div>
      )}
    </section>
  );
}
