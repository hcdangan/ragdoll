import type { ReactElement, SVGProps } from "react";

/**
 * Inline icon set.
 *
 * Icons ship as components rather than an icon package: the app uses eighteen
 * glyphs, and a dependency for that would cost more in bundle size and supply
 * chain than it saves in keystrokes. Each icon is decorative by default
 * (`aria-hidden`), because every control that uses one also carries a label.
 */

type IconProps = SVGProps<SVGSVGElement>;

const base = (props: IconProps): IconProps => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  width: 18,
  height: 18,
  ...props,
});

export const IconHome = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20h13V9.5" />
    <path d="M9.5 20v-6h5v6" />
  </svg>
);

export const IconWand = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="m4 20 9-9" />
    <path d="M14.5 4.5 15 6l1.5.5L15 7l-.5 1.5L14 7l-1.5-.5L14 6Z" />
    <path d="M19 11l.4 1.1L20.5 12.5 19.4 13 19 14l-.4-1.1L17.5 12.5l1.1-.4Z" />
    <path d="M9.5 3.5 10 5l1.5.5L10 6l-.5 1.5L9 6l-1.5-.5L9 5Z" />
  </svg>
);

export const IconGauge = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 18a8 8 0 1 1 16 0" />
    <path d="m12 14 4-4" />
    <circle cx="12" cy="15" r="1.5" />
  </svg>
);

export const IconChat = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 5.5h16v10H9l-5 4Z" />
    <path d="M8 9.5h8M8 12.5h5" />
  </svg>
);

export const IconSend = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 12 20 4l-7 16-2-6Z" />
    <path d="m11 14 9-10" />
  </svg>
);

export const IconStop = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconUpload = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M5 20h14" />
  </svg>
);

export const IconFile = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M6 3h7l5 5v13H6Z" />
    <path d="M13 3v5h5" />
    <path d="M9 13h6M9 16.5h4" />
  </svg>
);

export const IconTrash = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const IconEye = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
    <circle cx="12" cy="12" r="2.75" />
  </svg>
);

export const IconEyeOff = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 5l16 14" />
    <path d="M9.6 9.7A2.75 2.75 0 0 0 12 14.75c.8 0 1.5-.33 2-.86" />
    <path d="M6.2 7.4C3.9 9 2.5 12 2.5 12S6 18 12 18c1.6 0 3-.4 4.2-1" />
    <path d="M18.4 15.1c1.8-1.4 3.1-3.1 3.1-3.1S18 6 12 6c-.7 0-1.4.1-2 .2" />
  </svg>
);

export const IconSun = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
  </svg>
);

export const IconMoon = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
);

export const IconSpinner = (props: IconProps): ReactElement => (
  <svg {...base(props)} className={`animate-spin ${props.className ?? ""}`}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

export const IconCheck = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
);

export const IconAlert = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M12 4 3 20h18L12 4Z" />
    <path d="M12 10v4.5M12 17.4v.1" />
  </svg>
);

export const IconInfo = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </svg>
);

export const IconLock = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </svg>
);

export const IconDatabase = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
    <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
  </svg>
);

export const IconQuote = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M9 6.5C6.5 7.5 5 9.8 5 12.5V18h5v-5H7.5c0-1.7.6-3 2-4Z" />
    <path d="M18 6.5c-2.5 1-4 3.3-4 6V18h5v-5h-2.5c0-1.7.6-3 2-4Z" />
  </svg>
);

export const IconChevron = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const IconRefresh = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
    <path d="M20 20v-4.5h-4.5" />
  </svg>
);

export const IconSparkle = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M12 3.5 13.6 9 19 10.5 13.6 12 12 17.5 10.4 12 5 10.5 10.4 9Z" />
    <path d="M18.5 16.5l.6 2 2 .6-2 .6-.6 2-.6-2-2-.6 2-.6Z" />
  </svg>
);

export const IconMenu = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconClose = (props: IconProps): ReactElement => (
  <svg {...base(props)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
