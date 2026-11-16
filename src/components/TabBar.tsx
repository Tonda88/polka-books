import { navigate, useRoute, type Screen } from '../lib/router';
import { Icon } from './Icons';

const TABS: Array<{ screen: Screen; path: string; label: string; icon: string }> = [
  { screen: 'home', path: '/', label: 'Главная', icon: 'home' },
  { screen: 'search', path: '/search', label: 'Поиск', icon: 'search' },
  { screen: 'mybooks', path: '/my', label: 'Мои книги', icon: 'library' },
  { screen: 'goals', path: '/goals', label: 'Цели', icon: 'target' },
  { screen: 'profile', path: '/me', label: 'Профиль', icon: 'user' },
];

export function TabBar() {
  const route = useRoute();
  return (
    <nav className="tab-bar" aria-label="Основная навигация">
      {TABS.map((tab) => {
        const active = route.screen === tab.screen;
        return (
          <button
            key={tab.screen}
            type="button"
            className={`tab-bar__item ${active ? 'is-active' : ''}`}
            onClick={() => navigate(tab.path)}
            aria-current={active ? 'page' : undefined}
          >
            <span className="tab-bar__icon">
              <Icon name={tab.icon} size={22} />
            </span>
            <span className="tab-bar__label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
