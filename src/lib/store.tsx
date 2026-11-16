import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppState,
  Bookmark,
  DownloadProgress,
  Goal,
  GoalMetric,
  GoalPeriod,
  Mode,
  Profile,
  ProgressEntry,
  Rating,
  ReadingSession,
  Settings,
} from '../types';
import { clearAllData, kvGet, kvSet, KV_KEYS, type KvKey } from './db';
import { deleteDownloadedBook, downloadBook } from './content';
import { dayKey } from './format';
import { periodRange } from './goals';
import { BOOKS } from '../data/books';

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontScale: 1,
  serif: true,
  ttsRate: 1,
  ttsVoice: null,
  autoListen: false,
  googleBooksKey: null,
};

const DEFAULT_PROFILE: Profile = {
  name: '',
  interests: [],
  onboarded: false,
  createdAt: 0,
};

const STATE_KEYS: Record<KvKey, keyof AppState> = {
  profile: 'profile',
  settings: 'settings',
  progress: 'progress',
  sessions: 'sessions',
  goals: 'goals',
  ratings: 'ratings',
  bookmarks: 'bookmarks',
  downloads: 'downloads',
};

export interface ToastItem {
  id: string;
  message: string;
  kind: 'info' | 'success' | 'error';
}

export interface ProgressInput {
  bookId: string;
  chapter: number;
  paragraph: number;
  percent: number;
  lastMode: Mode;
}

export interface OnboardingResult {
  name: string;
  interests: string[];
  presets: Array<{ period: GoalPeriod; metric: GoalMetric; target: number }>;
}

export interface AppContextValue {
  state: AppState;
  loading: boolean;
  toasts: ToastItem[];
  pushToast: (message: string, kind?: ToastItem['kind']) => void;
  dismissToast: (id: string) => void;
  updateProfile: (patch: Partial<Profile>) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  completeOnboarding: (result: OnboardingResult) => void;
  saveProgress: (input: ProgressInput) => void;
  markFinished: (bookId: string) => void;
  addSession: (bookId: string, mode: Mode, minutes: number, pages: number) => void;
  addGoal: (draft: { period: GoalPeriod; metric: GoalMetric; target: number }) => void;
  updateGoal: (id: string, patch: Partial<Pick<Goal, 'period' | 'metric' | 'target'>>) => void;
  deleteGoal: (id: string) => void;
  rateBook: (bookId: string, stars: number, liked: boolean) => void;
  addBookmark: (bookmark: Omit<Bookmark, 'id' | 'at'>) => void;
  removeBookmark: (id: string) => void;
  download: (bookId: string, onProgress?: (progress: DownloadProgress) => void) => Promise<void>;
  removeDownload: (bookId: string) => Promise<void>;
  seedDemo: () => void;
  resetAll: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultState(): AppState {
  return {
    profile: { ...DEFAULT_PROFILE },
    settings: { ...DEFAULT_SETTINGS },
    progress: {},
    sessions: [],
    goals: [],
    ratings: {},
    bookmarks: [],
    downloads: {},
  };
}

async function loadState(): Promise<AppState> {
  const state = defaultState();
  try {
    const values = await Promise.all(KV_KEYS.map((key) => kvGet<unknown>(key)));
    KV_KEYS.forEach((key, index) => {
      const value = values[index];
      if (value === undefined || value === null) return;
      const field = STATE_KEYS[key];
      if (key === 'profile' && typeof value === 'object') {
        state.profile = { ...DEFAULT_PROFILE, ...(value as Profile) };
      } else if (key === 'settings' && typeof value === 'object') {
        state.settings = { ...DEFAULT_SETTINGS, ...(value as Settings) };
      } else {
        (state[field] as unknown) = value;
      }
    });
  } catch (error) {
    console.warn('Не удалось прочитать сохранённые данные', error);
  }
  return state;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const stateRef = useRef<AppState | null>(null);
  const toastTimers = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadState().then((loaded) => {
      if (cancelled) return;
      stateRef.current = loaded;
      setState(loaded);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      toastTimers.current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, kind: ToastItem['kind'] = 'info') => {
      const toast: ToastItem = { id: uid(), message, kind };
      setToasts((prev) => [...prev.slice(-2), toast]);
      const timer = window.setTimeout(() => dismissToast(toast.id), 3400);
      toastTimers.current.push(timer);
    },
    [dismissToast],
  );

  const apply = useCallback((updater: (prev: AppState) => AppState) => {
    const previous = stateRef.current;
    if (!previous) return;
    const next = updater(previous);
    if (next === previous) return;
    stateRef.current = next;
    setState(next);
    for (const key of KV_KEYS) {
      const field = STATE_KEYS[key];
      if (previous[field] !== next[field]) {
        void kvSet(key, next[field]).catch((error) => console.warn('Не удалось сохранить', key, error));
      }
    }
  }, []);

  const updateProfile = useCallback(
    (patch: Partial<Profile>) => {
      apply((prev) => ({ ...prev, profile: { ...prev.profile, ...patch } }));
    },
    [apply],
  );

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      apply((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
    },
    [apply],
  );

  const createGoal = useCallback(
    (draft: { period: GoalPeriod; metric: GoalMetric; target: number }): Goal => ({
      id: uid(),
      period: draft.period,
      metric: draft.metric,
      target: Math.max(1, Math.round(draft.target)),
      createdAt: Date.now(),
    }),
    [],
  );

  const completeOnboarding = useCallback(
    (result: OnboardingResult) => {
      apply((prev) => ({
        ...prev,
        profile: {
          ...prev.profile,
          name: result.name.trim() || 'Читатель',
          interests: result.interests,
          onboarded: true,
          createdAt: prev.profile.createdAt || Date.now(),
        },
        goals: [...prev.goals, ...result.presets.map(createGoal)],
      }));
    },
    [apply, createGoal],
  );

  const saveProgress = useCallback(
    (input: ProgressInput) => {
      const now = Date.now();
      apply((prev) => {
        const existing = prev.progress[input.bookId];
        if (
          existing &&
          existing.chapter === input.chapter &&
          existing.paragraph === input.paragraph &&
          Math.abs(existing.percent - input.percent) < 0.01 &&
          existing.lastMode === input.lastMode
        ) {
          return prev;
        }
        const entry: ProgressEntry = {
          bookId: input.bookId,
          chapter: input.chapter,
          paragraph: input.paragraph,
          percent: Math.max(existing?.percent ?? 0, Math.min(100, input.percent)),
          lastMode: input.lastMode,
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
          finishedAt: existing?.finishedAt,
        };
        return { ...prev, progress: { ...prev.progress, [input.bookId]: entry } };
      });
    },
    [apply],
  );

  const markFinished = useCallback(
    (bookId: string) => {
      apply((prev) => {
        const existing = prev.progress[bookId];
        if (existing?.finishedAt) return prev;
        const now = Date.now();
        return {
          ...prev,
          progress: {
            ...prev.progress,
            [bookId]: {
              bookId,
              chapter: existing?.chapter ?? 0,
              paragraph: existing?.paragraph ?? 0,
              percent: 100,
              lastMode: existing?.lastMode ?? 'read',
              startedAt: existing?.startedAt ?? now,
              updatedAt: now,
              finishedAt: now,
            },
          },
        };
      });
    },
    [apply],
  );

  const addSession = useCallback(
    (bookId: string, mode: Mode, minutes: number, pages: number) => {
      const safeMinutes = Math.round(minutes * 10) / 10;
      const safePages = Math.round(pages * 10) / 10;
      if (safeMinutes <= 0 && safePages <= 0) return;
      const now = Date.now();
      const session: ReadingSession = {
        id: uid(),
        ts: now,
        date: dayKey(now),
        bookId,
        mode,
        minutes: Math.max(0, safeMinutes),
        pages: Math.max(0, safePages),
      };
      apply((prev) => ({
        ...prev,
        sessions: [...prev.sessions.slice(-2999), session],
      }));
    },
    [apply],
  );

  const addGoal = useCallback(
    (draft: { period: GoalPeriod; metric: GoalMetric; target: number }) => {
      apply((prev) => ({ ...prev, goals: [...prev.goals, createGoal(draft)] }));
      pushToast('Цель создана — покажем прогресс на экране целей', 'success');
    },
    [apply, createGoal, pushToast],
  );

  const updateGoal = useCallback(
    (id: string, patch: Partial<Pick<Goal, 'period' | 'metric' | 'target'>>) => {
      apply((prev) => ({
        ...prev,
        goals: prev.goals.map((goal) =>
          goal.id === id
            ? { ...goal, ...patch, target: patch.target ? Math.max(1, Math.round(patch.target)) : goal.target }
            : goal,
        ),
      }));
    },
    [apply],
  );

  const deleteGoal = useCallback(
    (id: string) => {
      apply((prev) => ({ ...prev, goals: prev.goals.filter((goal) => goal.id !== id) }));
      pushToast('Цель удалена');
    },
    [apply, pushToast],
  );

  const rateBook = useCallback(
    (bookId: string, stars: number, liked: boolean) => {
      const rating: Rating = { bookId, stars, liked, at: Date.now() };
      apply((prev) => ({ ...prev, ratings: { ...prev.ratings, [bookId]: rating } }));
      pushToast('Спасибо! Рекомендации станут точнее', 'success');
    },
    [apply, pushToast],
  );

  const addBookmark = useCallback(
    (bookmark: Omit<Bookmark, 'id' | 'at'>) => {
      const entry: Bookmark = { ...bookmark, id: uid(), at: Date.now() };
      apply((prev) => {
        const exists = prev.bookmarks.some(
          (item) =>
            item.bookId === bookmark.bookId &&
            item.chapter === bookmark.chapter &&
            item.paragraph === bookmark.paragraph,
        );
        if (exists) return prev;
        return { ...prev, bookmarks: [entry, ...prev.bookmarks] };
      });
      pushToast('Закладка добавлена', 'success');
    },
    [apply, pushToast],
  );

  const removeBookmark = useCallback(
    (id: string) => {
      apply((prev) => ({ ...prev, bookmarks: prev.bookmarks.filter((item) => item.id !== id) }));
      pushToast('Закладка удалена');
    },
    [apply, pushToast],
  );

  const download = useCallback(
    async (bookId: string, onProgress?: (progress: DownloadProgress) => void) => {
      const { bytes } = await downloadBook(bookId, onProgress);
      apply((prev) => ({
        ...prev,
        downloads: {
          ...prev.downloads,
          [bookId]: { bookId, bytes, at: Date.now() },
        },
      }));
      pushToast('Книга скачана — читайте без интернета', 'success');
    },
    [apply, pushToast],
  );

  const removeDownload = useCallback(
    async (bookId: string) => {
      await deleteDownloadedBook(bookId);
      apply((prev) => {
        const downloads = { ...prev.downloads };
        delete downloads[bookId];
        return { ...prev, downloads };
      });
      pushToast('Скачанная книга удалена с устройства');
    },
    [apply, pushToast],
  );

  const seedDemo = useCallback(() => {
    const now = Date.now();
    const progress: Record<string, ProgressEntry> = {
      onegin: {
        bookId: 'onegin',
        chapter: 2,
        paragraph: 0,
        percent: 18,
        lastMode: 'read',
        startedAt: now - 8 * 86_400_000,
        updatedAt: now - 2 * 3_600_000,
      },
      'pikovaya-dama': {
        bookId: 'pikovaya-dama',
        chapter: 5,
        paragraph: 0,
        percent: 100,
        lastMode: 'listen',
        startedAt: now - 14 * 86_400_000,
        updatedAt: now - 3 * 86_400_000,
        finishedAt: now - 3 * 86_400_000,
      },
      'dama-s-sobachkoy': {
        bookId: 'dama-s-sobachkoy',
        chapter: 0,
        paragraph: 1,
        percent: 24,
        lastMode: 'read',
        startedAt: now - 4 * 86_400_000,
        updatedAt: now - 26 * 3_600_000,
      },
      'granatovyy-braslet': {
        bookId: 'granatovyy-braslet',
        chapter: 1,
        paragraph: 1,
        percent: 8,
        lastMode: 'listen',
        startedAt: now - 6 * 86_400_000,
        updatedAt: now - 5 * 3_600_000,
      },
      'chelovek-v-futlyare': {
        bookId: 'chelovek-v-futlyare',
        chapter: 0,
        paragraph: 0,
        percent: 100,
        lastMode: 'read',
        startedAt: now - 20 * 86_400_000,
        updatedAt: now - 12 * 86_400_000,
        finishedAt: now - 12 * 86_400_000,
      },
    };

    const ratings: Record<string, Rating> = {
      'pikovaya-dama': { bookId: 'pikovaya-dama', stars: 5, liked: true, at: now - 3 * 86_400_000 },
      'chelovek-v-futlyare': { bookId: 'chelovek-v-futlyare', stars: 5, liked: true, at: now - 12 * 86_400_000 },
      onegin: { bookId: 'onegin', stars: 4, liked: true, at: now - 2 * 86_400_000 },
      'dama-s-sobachkoy': { bookId: 'dama-s-sobachkoy', stars: 4, liked: false, at: now - 86_400_000 },
    };

    const bookmarks: Bookmark[] = [
      {
        id: uid(),
        bookId: 'onegin',
        chapter: 2,
        paragraph: 0,
        chapterTitle: 'Глава первая',
        text: '«Мой дядя самых честных правил, Когда не в шутку занемог, Он уважать себя заставил И лучше выдумать не мог…»',
        at: now - 2 * 86_400_000,
      },
      {
        id: uid(),
        bookId: 'dama-s-sobachkoy',
        chapter: 0,
        paragraph: 0,
        chapterTitle: 'Глава I',
        text: 'Говорили, что на набережной появилось новое лицо: дама с собачкой.',
        at: now - 26 * 3_600_000,
      },
    ];

    // Псевдослучайные, но стабильные сессии за последние 45 дней.
    let seed = 20261116;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const bookIds = BOOKS.map((book) => book.id);
    const sessions: ReadingSession[] = [];
    for (let offset = 44; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - offset);
      const isRecent = offset <= 6;
      if (!isRecent && random() < 0.32) continue;
      const minutes = Math.round(18 + random() * 42);
      const pages = Math.round(8 + random() * 38);
      const mode: Mode = random() < 0.28 ? 'listen' : 'read';
      const bookId = bookIds[Math.floor(random() * bookIds.length)];
      sessions.push({
        id: uid(),
        ts: date.getTime(),
        date: dayKey(date.getTime()),
        bookId,
        mode,
        minutes,
        pages,
      });
    }

    const weekRange = periodRange('week', now);
    const monthRange = periodRange('month', now);
    const weekMinutes = sessions
      .filter((session) => session.ts >= weekRange.start && session.ts < weekRange.end)
      .reduce((sum, session) => sum + session.minutes, 0);
    const monthPages = sessions
      .filter((session) => session.ts >= monthRange.start && session.ts < monthRange.end)
      .reduce((sum, session) => sum + session.pages, 0);
    const weekFraction = Math.max(0.12, (now - weekRange.start) / (weekRange.end - weekRange.start));
    const monthFraction = Math.max(0.12, (now - monthRange.start) / (monthRange.end - monthRange.start));

    const goals: Goal[] = [
      {
        id: uid(),
        period: 'week',
        metric: 'minutes',
        target: Math.max(30, Math.round((weekMinutes / weekFraction / 10) * 10)),
        createdAt: now - 10 * 86_400_000,
      },
      {
        id: uid(),
        period: 'month',
        metric: 'pages',
        target: Math.max(100, Math.round((monthPages / monthFraction / 50) * 50)),
        createdAt: now - 28 * 86_400_000,
      },
      { id: uid(), period: 'year', metric: 'books', target: 12, createdAt: now - 60 * 86_400_000 },
    ];

    apply(() => ({
      profile: {
        name: 'Аня Смирнова',
        interests: ['классика', 'психология', 'поэзия'],
        onboarded: true,
        createdAt: now - 90 * 86_400_000,
      },
      settings: stateRef.current?.settings ?? DEFAULT_SETTINGS,
      progress,
      sessions,
      ratings,
      bookmarks,
      goals,
      downloads: {},
    }));
    pushToast('Демо-данные готовы: прогресс, цели и история чтения', 'success');
  }, [apply, pushToast]);

  const resetAll = useCallback(async () => {
    await clearAllData();
    window.location.reload();
  }, []);

  const value = useMemo<AppContextValue | null>(() => {
    if (!state) return null;
    return {
      state,
      loading,
      toasts,
      pushToast,
      dismissToast,
      updateProfile,
      updateSettings,
      completeOnboarding,
      saveProgress,
      markFinished,
      addSession,
      addGoal,
      updateGoal,
      deleteGoal,
      rateBook,
      addBookmark,
      removeBookmark,
      download,
      removeDownload,
      seedDemo,
      resetAll,
    };
  }, [
    state,
    loading,
    toasts,
    pushToast,
    dismissToast,
    updateProfile,
    updateSettings,
    completeOnboarding,
    saveProgress,
    markFinished,
    addSession,
    addGoal,
    updateGoal,
    deleteGoal,
    rateBook,
    addBookmark,
    removeBookmark,
    download,
    removeDownload,
    seedDemo,
    resetAll,
  ]);

  if (!value || !state) {
    return (
      <AppContext.Provider value={null as unknown as AppContextValue}>
        <div className="boot-screen">
          <div className="boot-logo">Полка</div>
          <div className="boot-hint">Загружаем библиотеку…</div>
        </div>
      </AppContext.Provider>
    );
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp должен использоваться внутри AppProvider');
  return context;
}

export function useAppOptional(): AppContextValue | null {
  return useContext(AppContext);
}
