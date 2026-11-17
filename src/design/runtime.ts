import { applyAppearance } from './appearance';
import type { Settings } from '../types';

let media: MediaQueryList | null = null;
let listener: (() => void) | null = null;
let current: Settings | null = null;

/** Синхронизировать тему с системной настройкой при режиме «Как в системе». */
export function bindSystemAppearance(root: HTMLElement, settings: Settings): () => void {
  current = settings;
  if (!media) media = window.matchMedia('(prefers-color-scheme: light)');
  if (listener) media.removeEventListener?.('change', listener);
  listener = () => {
    if (current?.appearanceMode === 'system') applyAppearance(root, current);
  };
  media.addEventListener?.('change', listener);
  applyAppearance(root, settings);
  return () => {
    if (listener && media) media.removeEventListener?.('change', listener);
    listener = null;
  };
}
