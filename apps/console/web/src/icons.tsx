// The console's icons: the Journear Passport design system's set (its 16 and 20 px grids, 1.75 px stroke, round caps
// and joins), drawn inline so they take the text colour. Decorative: aria-hidden; the control around one has the name.
import type { ReactNode } from 'react';

type P = { className?: string | undefined };

const icon = (box: 16 | 20, d: ReactNode) =>
  function Icon({ className }: P) {
    return (
      <svg
        className={className ?? 'icon'}
        viewBox={`0 0 ${box} ${box}`}
        width={box === 16 ? 16 : 20}
        height={box === 16 ? 16 : 20}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {d}
      </svg>
    );
  };

export const IconCopy = icon(16, <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>);
export const IconCheck = icon(16, <path d="M3 8.5l3 3 7-7" />);
export const IconCheckCircle = icon(20, <><circle cx="10" cy="10" r="8" /><path d="M6.5 10.5l2.3 2.3L13.5 8" /></>);
export const IconX = icon(16, <path d="M4 4l8 8M12 4l-8 8" />);
export const IconInfo = icon(20, <><circle cx="10" cy="10" r="8" /><path d="M10 9v5M10 6.5v.1" /></>);
export const IconAlert = icon(20, <><path d="M10 3l8 14H2z" /><path d="M10 8v4M10 14.5v.1" /></>);
export const IconBack = icon(16, <path d="M10 4L6 8l4 4" />);
export const IconChevron = icon(16, <path d="M6 4l4 4-4 4" />);
export const IconShield = icon(16, <path d="M8 1.5l5.5 2v4c0 3.5-2.5 5.8-5.5 7-3-1.2-5.5-3.5-5.5-7v-4z" />);
export const IconClock = icon(16, <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>);
export const IconKey = icon(20, <><circle cx="7" cy="12" r="4" /><path d="M10 9l7-7M14 5l2 2M12 7l2 2" /></>);
export const IconMail = icon(20, <><rect x="2.5" y="4.5" width="15" height="11" rx="2" /><path d="M3 6l7 5 7-5" /></>);
export const IconSearch = icon(16, <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>);
export const IconWallet = icon(20, <><rect x="2.5" y="5" width="15" height="11" rx="2" /><path d="M2.5 8h15M13 12h2" /></>);
