/** Единые токены внешнего вида приложения. */
import type { Settings } from '../types';

export type AppearanceTheme = 'graphite' | 'ivory' | 'midnight' | 'forest' | 'sand';
export type AppearanceMode = 'system' | 'dark' | 'light';
export type CardStyle = 'cover' | 'minimal' | 'comfortable';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type AccentId = 'olive' | 'champagne' | 'bronze' | 'sage' | 'terracotta';

export interface ThemeSpec {
  id: AppearanceTheme;
  name: string;
  description: string;
  colors: Record<string, string>;
}

export const THEMES: ThemeSpec[] = [
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Графит, олива, шампань',
    colors: {
      bg: '#171714', bgSoft: '#1d1d19', surface: '#23231e', surface2: '#2b2b24', surface3: '#37372e',
      text: '#f2efe4', muted: '#aaa694', muted2: '#777565', border: 'rgba(242,239,228,.08)',
      borderStrong: 'rgba(242,239,228,.15)', accent: '#a4a879', accent2: '#c9b985', green: '#8ea878', red: '#d17a70',
      accentSoft: 'rgba(164,168,121,.16)', shadow: 'rgba(0,0,0,.32)',
    },
  },
  {
    id: 'ivory',
    name: 'Ivory',
    description: 'Кремовая книжная тема',
    colors: {
      bg: '#f3efe5', bgSoft: '#eee9de', surface: '#faf7ef', surface2: '#e9e3d6', surface3: '#ddd5c6',
      text: '#28271f', muted: '#777367', muted2: '#979182', border: 'rgba(48,43,31,.09)',
      borderStrong: 'rgba(48,43,31,.16)', accent: '#69734e', accent2: '#9b7951', green: '#577a52', red: '#aa534b',
      accentSoft: 'rgba(105,115,78,.13)', shadow: 'rgba(56,47,31,.12)',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Тёмный минимализм',
    colors: {
      bg: '#101214', bgSoft: '#15181b', surface: '#1a1e21', surface2: '#23282c', surface3: '#30363a',
      text: '#eef0ed', muted: '#9ba39f', muted2: '#6e7873', border: 'rgba(238,240,237,.07)',
      borderStrong: 'rgba(238,240,237,.13)', accent: '#879b87', accent2: '#c0aa7c', green: '#77ad8b', red: '#d17b75',
      accentSoft: 'rgba(135,155,135,.14)', shadow: 'rgba(0,0,0,.42)',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Глубокие зелёные оттенки',
    colors: {
      bg: '#121a16', bgSoft: '#17211b', surface: '#1c2921', surface2: '#26362c', surface3: '#34483a',
      text: '#edf0e7', muted: '#a5b09f', muted2: '#74816e', border: 'rgba(237,240,231,.08)',
      borderStrong: 'rgba(237,240,231,.15)', accent: '#8fa578', accent2: '#c3a777', green: '#86aa7e', red: '#d17a70',
      accentSoft: 'rgba(143,165,120,.16)', shadow: 'rgba(0,0,0,.36)',
    },
  },
  {
    id: 'sand',
    name: 'Sand',
    description: 'Тёплый песок и бронза',
    colors: {
      bg: '#211e19', bgSoft: '#29251e', surface: '#302b23', surface2: '#3b342a', surface3: '#4a4033',
      text: '#f4eee2', muted: '#b4a995', muted2: '#897e6b', border: 'rgba(244,238,226,.08)',
      borderStrong: 'rgba(244,238,226,.15)', accent: '#b69b6d', accent2: '#d2bb8e', green: '#91a07a', red: '#d27d71',
      accentSoft: 'rgba(182,155,109,.15)', shadow: 'rgba(0,0,0,.38)',
    },
  },
];

export const ACCENT_SWATCHES = [
  { id: 'olive', name: 'Олива', value: '#a4a879' },
  { id: 'champagne', name: 'Шампань', value: '#c9b985' },
  { id: 'bronze', name: 'Бронза', value: '#b68a5a' },
  { id: 'sage', name: 'Шалфей', value: '#8fae99' },
  { id: 'terracotta', name: 'Терракота', value: '#bb8068' },
];

const DARK_OVERRIDES: Record<string, string> = {
  '--bg': '#171714', '--bg-soft': '#1d1d19', '--surface': '#23231e', '--surface-2': '#2b2b24', '--surface-3': '#37372e',
  '--text': '#f2efe4', '--muted': '#aaa694', '--muted-2': '#777565', '--border': 'rgba(242,239,228,.08)',
  '--border-strong': 'rgba(242,239,228,.15)',
};
const LIGHT_OVERRIDES: Record<string, string> = {
  '--bg': '#f3efe5', '--bg-soft': '#eee9de', '--surface': '#faf7ef', '--surface-2': '#e9e3d6', '--surface-3': '#ddd5c6',
  '--text': '#28271f', '--muted': '#777367', '--muted-2': '#979182', '--border': 'rgba(48,43,31,.09)',
  '--border-strong': 'rgba(48,43,31,.16)',
};

export function applyAppearance(root: HTMLElement, settings: Settings): void {
  const theme = (settings.appearanceTheme ?? 'graphite') as AppearanceTheme;
  const mode = settings.appearanceMode ?? 'system';
  const systemLight = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches;
  const spec = THEMES.find((item) => item.id === theme) ?? THEMES[0];
  const colors = { ...spec.colors };
  // Светлый/тёмный режим — отдельный слой поверх палитры. System берёт
  // палитру темы (Ivory светлая, остальные тёмные) и учитывает настройку ОС.
  if (mode === 'light') Object.assign(colors, fromVars(LIGHT_OVERRIDES));
  if (mode === 'dark' && theme === 'ivory') Object.assign(colors, fromVars(DARK_OVERRIDES));
  if (mode === 'system' && theme === 'ivory' && !systemLight) Object.assign(colors, fromVars(DARK_OVERRIDES));
  const accent = ACCENT_SWATCHES.find((item) => item.id === settings.accentColor)?.value;
  if (accent) colors.accent = accent;

  const vars: Record<string, string> = {
    '--bg': colors.bg,
    '--bg-soft': colors.bgSoft,
    '--surface': colors.surface,
    '--surface-2': colors.surface2,
    '--surface-3': colors.surface3,
    '--text': colors.text,
    '--muted': colors.muted,
    '--muted-2': colors.muted2,
    '--border': colors.border,
    '--border-strong': colors.borderStrong,
    '--accent': colors.accent,
    '--accent-2': colors.accent2,
    '--accent-soft': accent ? `color-mix(in srgb, ${accent} 16%, transparent)` : colors.accentSoft,
    '--green': colors.green,
    '--red': colors.red,
    '--shadow-color': colors.shadow,
    '--app-font-scale': String(settings.uiFontScale ?? 1),
    '--app-density': densityValue(settings.uiDensity ?? 'comfortable'),
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.appTheme = theme;
  root.dataset.appMode = mode;
  root.dataset.cardStyle = settings.cardStyle ?? 'cover';
  root.dataset.animations = settings.animations === false ? 'off' : 'on';
  const effectiveLight = mode === 'light' || (mode === 'system' && theme === 'ivory' && systemLight);
  root.style.colorScheme = effectiveLight ? 'light' : 'dark';
}

function fromVars(vars: Record<string, string>): Record<string, string> {
  return {
    bg: vars['--bg'], bgSoft: vars['--bg-soft'], surface: vars['--surface'], surface2: vars['--surface-2'],
    surface3: vars['--surface-3'], text: vars['--text'], muted: vars['--muted'], muted2: vars['--muted-2'],
    border: vars['--border'], borderStrong: vars['--border-strong'],
  };
}

function densityValue(density: string): string {
  if (density === 'compact') return '0.88';
  if (density === 'spacious') return '1.12';
  return '1';
}

export function isLightTheme(theme: AppearanceTheme): boolean {
  return theme === 'ivory';
}
