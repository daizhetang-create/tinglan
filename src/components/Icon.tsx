import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'mic'
  | 'library'
  | 'settings'
  | 'lock'
  | 'plus'
  | 'upload'
  | 'search'
  | 'play'
  | 'pause'
  | 'stop'
  | 'bookmark'
  | 'note'
  | 'download'
  | 'trash'
  | 'sparkles'
  | 'edit'
  | 'arrow'
  | 'headphones'
  | 'monitor'
  | 'check'
  | 'warning'
  | 'menu'
  | 'close'
  | 'star'
  | 'share'
  | 'folder'
  | 'calendar'
  | 'brain'
  | 'paperclip'
  | 'send'
  | 'history'
  | 'wand'
  | 'more';

const paths: Record<IconName, ReactNode> = {
  home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9h13v-9"/><path d="M9.5 19v-5h5v5"/></>,
  mic: <><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
  library: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2Z"/><path d="M5 17a2 2 0 0 1 2-2h12M9 8h6"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.13.4.34.74.6 1 .29.29.67.43 1.1.43H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 15v4h14v-4"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  play: <path d="m8 5 11 7-11 7Z"/>,
  pause: <><path d="M9 5v14M15 5v14"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
  bookmark: <path d="M6 4h12v17l-6-4-6 4Z"/>,
  note: <><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 20h14"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  sparkles: <><path d="m12 3 1.1 3.9L17 8l-3.9 1.1L12 13l-1.1-3.9L7 8l3.9-1.1Z"/><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"/><path d="m5 13 .8 2.7 2.7.8-2.7.8L5 20l-.8-2.7-2.7-.8 2.7-.8Z"/></>,
  edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10Z"/><path d="m13.5 7 3.5 3.5"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h4v6H6a2 2 0 0 1-2-2ZM20 14h-4v6h2a2 2 0 0 0 2-2Z"/></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  warning: <><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17.5v.1"/></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>,
  share: <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></>,
  folder: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z"/>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/></>,
  brain: <><path d="M9.5 5.5A3 3 0 0 0 4.8 8a3.2 3.2 0 0 0 .1 5.8A3.1 3.1 0 0 0 9.5 18"/><path d="M14.5 5.5A3 3 0 0 1 19.2 8a3.2 3.2 0 0 1-.1 5.8 3.1 3.1 0 0 1-4.6 4.2M12 4v16M8 9.5c.5.2 1 .7 1.2 1.3M16 9.5c-.5.2-1 .7-1.2 1.3M8.2 15c.6-.2 1.2-.1 1.7.3M15.8 15c-.6-.2-1.2-.1-1.7.3"/></>,
  paperclip: <path d="m9.5 12.5 5.7-5.7a3 3 0 1 1 4.2 4.2l-8.1 8.1a5 5 0 0 1-7.1-7.1l7.4-7.4a2.8 2.8 0 0 1 4 4l-7.3 7.3a1.2 1.2 0 0 1-1.7-1.7l6.5-6.5"/>,
  send: <><path d="m3 4 18 8-18 8 3-8Z"/><path d="M6 12h15"/></>,
  history: <><path d="M4.5 8.5A8 8 0 1 1 4 15M4.5 8.5V4M4.5 8.5H9"/><path d="M12 8v4l3 2"/></>,
  wand: <><path d="m5 19 10.5-10.5M13.5 6.5l4 4M5.5 4l.6 1.9L8 6.5l-1.9.6L5.5 9l-.6-1.9L3 6.5l1.9-.6ZM18.5 14l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
