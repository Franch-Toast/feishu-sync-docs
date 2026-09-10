import React from "react";

export type IconName =
  | "dashboard"
  | "docs"
  | "conflicts"
  | "history"
  | "tasks"
  | "settings"
  | "plus"
  | "sync"
  | "close"
  | "back";

const PATHS: Record<IconName, React.JSX.Element> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="8.5" rx="1.6" />
      <rect x="14" y="3.5" width="6.5" height="5" rx="1.6" />
      <rect x="14" y="12" width="6.5" height="8.5" rx="1.6" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.6" />
    </>
  ),
  docs: (
    <>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5v5h5" />
    </>
  ),
  conflicts: (
    <>
      <path d="M12 4 3 19.5h18z" />
      <path d="M12 10.5v3.5" />
      <path d="M12 17.2v.05" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  tasks: (
    <>
      <path d="M9 5.5h9.5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H9" />
      <path d="M4.5 8.5l1.8 1.8 3.2-3.4" />
      <path d="M4.5 15l1.8 1.8 3.2-3.4" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7.5h9" />
      <circle cx="17" cy="7.5" r="2.4" />
      <path d="M20 16.5h-9" />
      <circle cx="7" cy="16.5" r="2.4" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  sync: (
    <>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />
};

interface IconProps {
  name: IconName;
  size?: number;
}

/** Inline stroke icons so the shell needs no icon-font dependency. */
export function Icon({ name, size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
