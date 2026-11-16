import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { AppProvider, useApp } from './lib/store';
import { PlayerProvider, usePlayer } from './lib/player';
import { AudioProvider } from './audio/AudioPlayer';
import { isMainScreen, useRoute } from './lib/router';
import { HomeScreen } from './screens/Home';
import { CatalogScreen } from './screens/Catalog';
import { BookScreen } from './screens/BookPage';
import { ReaderScreen } from './screens/Reader';
import { PlayerScreen } from './screens/PlayerScreen';
import { LibraryScreen } from './screens/Library';
import { GoalsScreen } from './screens/Goals';
import { ProfileScreen } from './screens/Profile';
import { OnboardingScreen } from './screens/Onboarding';
import { SearchScreen } from './screens/Search';
import { BookDetailsScreen } from './screens/BookDetails';
import { MyBooksScreen } from './screens/MyBooks';
import { DownloadsScreen } from './screens/DownloadsScreen';
import { AudioBookScreen } from './screens/AudioBookScreen';
import { PreferencesScreen } from './screens/Preferences';
import { WebSearchScreen } from './screens/WebSearch';
import { downloads } from './downloads/manager';
import { ensureProxyMode } from './catalog/proxy';
import { TabBar } from './components/TabBar';
import { MiniPlayer } from './components/MiniPlayer';
import { Toaster } from './components/Toaster';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Ошибка приложения', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <h1>Что-то пошло не так</h1>
          <p>{this.state.error.message}</p>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Splash() {
  return (
    <div className="boot-screen">
      <div className="boot-logo">Полка</div>
      <div className="boot-hint">Загружаем библиотеку…</div>
    </div>
  );
}

function Shell() {
  const { state, loading } = useApp();
  const route = useRoute();
  const player = usePlayer();

  // Восстанавливаем скачанные сетевые книги и проверяем серверный прокси.
  useEffect(() => {
    void downloads.init();
    // Если приложение запущено со своего сервера, доступны прокси файлов
    // и опциональный серверный ключ Google Books (без ключа в клиенте).
    void ensureProxyMode();
  }, []);

  const fullScreen = route.screen === 'reader' || route.screen === 'player';
  const showTabs = isMainScreen(route.screen);
  const showMiniPlayer = Boolean(player.snapshot) && !fullScreen;

  useEffect(() => {
    const titles: Record<string, string> = {
      home: 'Полка — читай и слушай',
      catalog: 'Каталог · Полка',
      library: 'Моя полка · Полка',
      goals: 'Цели чтения · Полка',
      profile: 'Профиль · Полка',
      book: 'Книга · Полка',
      reader: 'Чтение · Полка',
      player: 'Аудиокнига · Полка',
      search: 'Поиск книг · Полка',
      details: 'Книга · Полка',
      mybooks: 'Мои книги · Полка',
      prefs: 'Вкус и предпочтения · Полка',
      web: 'Поиск в интернете · Полка',
      downloads: 'Загрузки · Полка',
      audio: 'Аудиокнига · Полка',
    };
    document.title = titles[route.screen] ?? 'Полка';
  }, [route.screen]);

  if (loading) return <Splash />;

  if (!state.profile.onboarded) {
    return (
      <>
        <OnboardingScreen />
        <Toaster />
      </>
    );
  }

  const renderScreen = () => {
    switch (route.screen) {
      case 'search':
        return <SearchScreen />;
      case 'details':
        return route.id ? <BookDetailsScreen bookId={route.id} /> : <SearchScreen />;
      case 'mybooks':
        return <MyBooksScreen />;
      case 'prefs':
        return <PreferencesScreen />;
      case 'web':
        return <WebSearchScreen />;
      case 'downloads':
        return <DownloadsScreen />;
      case 'audio':
        return route.id ? <AudioBookScreen bookId={route.id} /> : <SearchScreen />;
      case 'catalog':
        return <CatalogScreen />;
      case 'library':
        return <LibraryScreen />;
      case 'goals':
        return <GoalsScreen />;
      case 'profile':
        return <ProfileScreen />;
      case 'book':
        return route.id ? <BookScreen bookId={route.id} /> : <HomeScreen />;
      case 'reader':
        return route.id ? (
          <ReaderScreen bookId={route.id} chapter={route.chapter} paragraph={route.paragraph} />
        ) : (
          <HomeScreen />
        );
      case 'player':
        return <PlayerScreen bookId={route.id} />;
      default:
        return <HomeScreen />;
    }
  };

  return (
    <div className={`app ${fullScreen ? 'app--full' : ''}`}>
      <ErrorBoundary>
        <div
          className={`app__main ${showTabs || showMiniPlayer ? 'app__main--with-nav' : ''} ${
            showMiniPlayer ? 'app__main--with-player' : ''
          }`}
        >
          {renderScreen()}
        </div>
      </ErrorBoundary>
      {showMiniPlayer && <MiniPlayer />}
      {showTabs && <TabBar />}
      <Toaster />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AudioProvider>
        <PlayerProvider>
          <Shell />
        </PlayerProvider>
      </AudioProvider>
    </AppProvider>
  );
}
