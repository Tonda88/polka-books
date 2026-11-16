import type { CSSProperties, ReactNode } from 'react';

interface IconProps {
  size?: number;
  className?: string;
  filled?: boolean;
}

function Svg({ children, size = 24, className, filled }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconHome = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 10.7 12 4l8 6.7V20a1 1 0 0 1-1 1h-4.6v-6.2H9.6V21H5a1 1 0 0 1-1-1z" />
  </Svg>
);

export const IconCompass = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m15.7 8.3-2.1 5.3-5.3 2.1 2.1-5.3z" />
  </Svg>
);

export const IconLibrary = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4" width="4.2" height="17" rx="1.2" />
    <rect x="9.9" y="4" width="4.2" height="17" rx="1.2" />
    <path d="m17.4 4.8 3 16.2" />
  </Svg>
);

export const IconTarget = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.6" />
    <circle cx="12" cy="12" r="4.6" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconUser = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.5 21c.4-3.8 3.6-5.8 7.5-5.8s7.1 2 7.5 5.8" />
  </Svg>
);

export const IconSearch = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.8" />
    <path d="m16 16 4.4 4.4" />
  </Svg>
);

export const IconChevronLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="m15 5.5-6.5 6.5L15 18.5" />
  </Svg>
);

export const IconChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </Svg>
);

export const IconChevronDown = (props: IconProps) => (
  <Svg {...props}>
    <path d="m5.5 9 6.5 6.5L18.5 9" />
  </Svg>
);

export const IconPlay = (props: IconProps) => (
  <Svg {...props} filled>
    <path d="M8 4.8c0-.9 1-1.4 1.7-.9l10.1 6.6c.7.5.7 1.5 0 2l-10 6.7c-.7.5-1.8 0-1.8-.9z" />
  </Svg>
);

export const IconPause = (props: IconProps) => (
  <Svg {...props} filled>
    <rect x="6.2" y="4.5" width="3.8" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="3.8" height="15" rx="1.2" />
  </Svg>
);

export const IconSkipBack = (props: IconProps) => (
  <Svg {...props} filled>
    <rect x="4" y="5" width="2.4" height="14" rx="1.2" />
    <path d="M20 6.1v11.8c0 .9-1 1.4-1.7.9l-8.2-5.9c-.6-.4-.6-1.4 0-1.8l8.2-5.9c.7-.5 1.7 0 1.7.9z" />
  </Svg>
);

export const IconSkipForward = (props: IconProps) => (
  <Svg {...props} filled>
    <rect x="17.6" y="5" width="2.4" height="14" rx="1.2" />
    <path d="M4 6.1v11.8c0 .9 1 1.4 1.7.9l8.2-5.9c.6-.4.6-1.4 0-1.8L5.7 5.2C5 4.7 4 5.2 4 6.1z" />
  </Svg>
);

export const IconHeadphones = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.2 14.5v-2a7.8 7.8 0 0 1 15.6 0v2" />
    <rect x="3.2" y="14" width="4.6" height="6.4" rx="2.2" />
    <rect x="16.2" y="14" width="4.6" height="6.4" rx="2.2" />
  </Svg>
);

export const IconBookOpen = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 6.4C10.2 4.9 7.4 4.2 4.4 4.2v14.1c3 0 5.8.7 7.6 2.2 1.8-1.5 4.6-2.2 7.6-2.2V4.2c-3 0-5.8.7-7.6 2.2Z" />
    <path d="M12 6.4v14.1" />
  </Svg>
);

export const IconDownload = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5v11.4" />
    <path d="m7.2 10.4 4.8 4.8 4.8-4.8" />
    <path d="M4.5 20.5h15" />
  </Svg>
);

export const IconCheck = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4.5 12.4 5 5L19.5 6.6" />
  </Svg>
);

export const IconTrash = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 7h16" />
    <path d="M9.2 7V4.8h5.6V7" />
    <path d="m6.2 7 .9 13.2h9.8L17.8 7" />
    <path d="M10 11v5.6M14 11v5.6" />
  </Svg>
);

export const IconStar = (props: IconProps) => (
  <Svg {...props}>
    <path d="m12 3.6 2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.8l5.9-.8z" />
  </Svg>
);

export const IconHeart = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 20.2s-7.7-4.5-7.7-9.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.7 3c0 5.1-7.7 9.6-7.7 9.6Z" />
  </Svg>
);

export const IconBookmark = (props: IconProps) => (
  <Svg {...props}>
    <path d="M7 3.8h10a1 1 0 0 1 1 1v16l-6-4.1-6 4.1v-16a1 1 0 0 1 1-1Z" />
  </Svg>
);

export const IconX = (props: IconProps) => (
  <Svg {...props}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const IconTimer = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="13.4" r="7.6" />
    <path d="M12 9.6v4l2.6 1.7M9.4 2.8h5.2" />
  </Svg>
);

export const IconFlame = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12.4 2.8c.5 3.3-.8 4.7-2.4 6.3-1.6 1.6-3.1 3.3-3.1 5.9a5.4 5.4 0 0 0 10.8 0c0-2.2-1-3.7-2.1-5 .2 1.8-.3 3.2-1.6 3.8.7-3.9-.2-7.4-1.6-11Z" />
  </Svg>
);

export const IconPlus = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconClock = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 7.2V12l3.4 2.1" />
  </Svg>
);

export const IconWifiOff = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 3l18 18" />
    <path d="M8.4 15.6a5 5 0 0 1 7.2 0M5 12.2a10.4 10.4 0 0 1 3.5-2.3M15.6 9.9a10.4 10.4 0 0 1 3.5 2.3" />
    <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconSparkles = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5 13.7 8l4.5 1.7-4.5 1.7L12 16l-1.7-4.6L5.8 9.7 10.3 8z" />
    <path d="M18.6 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </Svg>
);

export const IconVolume = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 9.4h3.2L12 5.6v12.8l-4.8-3.8H4z" />
    <path d="M15.6 9a4.2 4.2 0 0 1 0 6M18.2 6.4a7.6 7.6 0 0 1 0 11.2" />
  </Svg>
);

export const IconSettings = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </Svg>
);

export const IconArrowLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 12H4.5" />
    <path d="m10.5 5.5-6 6.5 6 6.5" />
  </Svg>
);

export const IconList = (props: IconProps) => (
  <Svg {...props}>
    <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
    <circle cx="4.6" cy="6.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="17.5" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPencil = (props: IconProps) => (
  <Svg {...props}>
    <path d="m4 20 4.4-1 10.7-10.7a2.2 2.2 0 0 0-3.1-3.1L5.3 15.9z" />
    <path d="m14.6 6.8 2.6 2.6" />
  </Svg>
);

export const IconSun = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4" />
  </Svg>
);

export const IconMoon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2Z" />
  </Svg>
);

export const IconVolumeOff = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 9.4h3.2L12 5.6v12.8l-4.8-3.8H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);

export const IconChart = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20V4" />
    <path d="M4 20h16" />
    <path d="m7 15 3.5-4 3 2.6L20 7" />
  </Svg>
);

export function Icon({ name, size = 24, className, filled }: IconProps & { name: string }): ReactNode {
  const map: Record<string, (props: IconProps) => ReactNode> = {
    home: IconHome,
    compass: IconCompass,
    library: IconLibrary,
    target: IconTarget,
    user: IconUser,
    search: IconSearch,
    left: IconChevronLeft,
    right: IconChevronRight,
    down: IconChevronDown,
    play: IconPlay,
    pause: IconPause,
    skipBack: IconSkipBack,
    skipForward: IconSkipForward,
    headphones: IconHeadphones,
    book: IconBookOpen,
    download: IconDownload,
    check: IconCheck,
    trash: IconTrash,
    star: IconStar,
    heart: IconHeart,
    bookmark: IconBookmark,
    x: IconX,
    timer: IconTimer,
    flame: IconFlame,
    plus: IconPlus,
    clock: IconClock,
    wifiOff: IconWifiOff,
    sparkles: IconSparkles,
    volume: IconVolume,
    settings: IconSettings,
    back: IconArrowLeft,
    list: IconList,
    pencil: IconPencil,
    sun: IconSun,
    moon: IconMoon,
    mute: IconVolumeOff,
    chart: IconChart,
  };
  const Component = map[name] ?? IconSparkles;
  return <Component size={size} className={className} filled={filled} />;
}

export const coverStyle = (bg: [string, string], ink: string, accent: string): CSSProperties =>
  ({
    '--cover-bg-1': bg[0],
    '--cover-bg-2': bg[1],
    '--cover-ink': ink,
    '--cover-accent': accent,
  }) as CSSProperties;
