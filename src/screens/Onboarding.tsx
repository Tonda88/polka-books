import { useState } from 'react';
import { GENRES } from '../data/books';
import { GOAL_PRESETS, type GoalPreset } from '../lib/goals';
import { useApp } from '../lib/store';
import { Icon } from '../components/Icons';

const PRESETS: GoalPreset[] = [GOAL_PRESETS[1], GOAL_PRESETS[0], GOAL_PRESETS[3]];

const FEATURES = [
  {
    icon: 'download',
    title: 'Скачивайте книги',
    text: 'Текст и аудио сохраняются на устройстве — читайте без интернета.',
  },
  {
    icon: 'headphones',
    title: 'Слушайте с того же места',
    text: 'Позиция у текста и аудио общая: переключение занимает один тап.',
  },
  {
    icon: 'target',
    title: 'Ставьте цели',
    text: 'Неделя, месяц, год — прогресс по страницам и минутам считается сам.',
  },
  {
    icon: 'sparkles',
    title: 'Рекомендации под вас',
    text: 'Чем больше читаете и оцениваете, тем точнее подборки.',
  },
];

export function OnboardingScreen() {
  const { completeOnboarding } = useApp();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [interests, setInterests] = useState<string[]>([]);
  const [selected, setSelected] = useState<boolean[]>(() => PRESETS.map((_, index) => index === 0));

  const finish = () => {
    completeOnboarding({
      name,
      interests,
      presets: PRESETS.filter((_, index) => selected[index]).map((preset) => ({
        period: preset.period,
        metric: preset.metric,
        target: preset.target,
      })),
    });
  };

  const skip = () => completeOnboarding({ name: '', interests: [], presets: [] });

  const toggleInterest = (genre: string) => {
    setInterests((prev) =>
      prev.includes(genre) ? prev.filter((item) => item !== genre) : prev.length >= 6 ? prev : [...prev, genre],
    );
  };

  return (
    <div className="onboarding">
      <div className="onboarding__top">
        {step > 0 ? (
          <button type="button" className="icon-button" onClick={() => setStep(step - 1)} aria-label="Назад">
            <Icon name="left" size={21} />
          </button>
        ) : (
          <span className="onboarding__brand">ПОЛКА</span>
        )}
        <button type="button" className="link-button" onClick={skip}>
          Пропустить
        </button>
      </div>

      <div className="onboarding__dots">
        {[0, 1, 2].map((index) => (
          <span key={index} className={`onboarding__dot ${step >= index ? 'is-active' : ''}`} />
        ))}
      </div>

      {step === 0 && (
        <div className="onboarding__step">
          <div className="onboarding__logo">
            <span>П</span>
          </div>
          <h1 className="onboarding__title">
            Читайте.
            <br />
            Слушайте.
            <br />
            Достигайте.
          </h1>
          <p className="onboarding__lead">
            Ваша библиотека классики: скачивайте книги, слушайте с того же места и следите за целями по чтению.
          </p>
          <div className="feature-list">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="feature">
                <span className="feature__icon">
                  <Icon name={feature.icon} size={19} />
                </span>
                <div>
                  <strong>{feature.title}</strong>
                  <span>{feature.text}</span>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="btn btn--primary btn--wide btn--lg" onClick={() => setStep(1)}>
            Начать
            <Icon name="right" size={18} />
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="onboarding__step">
          <h1 className="onboarding__title onboarding__title--sm">Как вас зовут?</h1>
          <p className="onboarding__lead">Имя появится на главной. Можно пропустить.</p>
          <label className="field">
            <span className="field__label">Имя</span>
            <input
              className="text-input"
              placeholder="Например, Аня"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={30}
              aria-label="Ваше имя"
            />
          </label>

          <div className="onboarding__block">
            <div className="onboarding__block-head">
              <strong>Что вам нравится читать?</strong>
              <span>{interests.length}/6</span>
            </div>
            <p className="onboarding__hint">Выберите до шести жанров — с них начнутся рекомендации.</p>
            <div className="chips-row chips-row--wrap">
              {GENRES.map((genre) => (
                <button
                  key={genre}
                  type="button"
                  className={`chip ${interests.includes(genre) ? 'is-active' : ''}`}
                  onClick={() => toggleInterest(genre)}
                >
                  {genre}
                </button>
              ))}
            </div>
          </div>

          <button type="button" className="btn btn--primary btn--wide btn--lg" onClick={() => setStep(2)}>
            Дальше
            <Icon name="right" size={18} />
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="onboarding__step">
          <h1 className="onboarding__title onboarding__title--sm">Поставьте первые цели</h1>
          <p className="onboarding__lead">
            Цели помогают читать регулярно. Прогресс считается автоматически по страницам, минутам и книгам.
          </p>
          <div className="preset-list">
            {PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                className={`preset-card ${selected[index] ? 'is-selected' : ''}`}
                onClick={() =>
                  setSelected((prev) => prev.map((value, itemIndex) => (itemIndex === index ? !value : value)))
                }
              >
                <span className="preset-card__check">
                  <Icon name="check" size={15} />
                </span>
                <span className="preset-card__body">
                  <strong>{preset.label}</strong>
                  <span>
                    {preset.period === 'year' ? 'год' : preset.period === 'month' ? 'месяц' : 'неделя'} ·{' '}
                    {preset.metric === 'books' ? 'книги' : preset.metric === 'pages' ? 'страницы' : 'минуты'}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <p className="onboarding__hint">Цели можно менять и добавлять в любой момент.</p>
          <button type="button" className="btn btn--primary btn--wide btn--lg" onClick={finish}>
            Начать читать
            <Icon name="book" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
