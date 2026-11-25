import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg">;

const base = { focusable: false, fill: "none" } as const;

export function SearchIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" {...base} {...props}>
      <circle cx="8.5" cy="8.5" r="6" stroke="currentColor" strokeWidth="2" />
      <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" {...base} {...props}>
      <path d="m4 4 6 6M10 4l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" {...base} {...props}>
      <path
        d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TilesIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" {...base} {...props}>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.6" fill="currentColor" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.6" fill="currentColor" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.6" fill="currentColor" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.6" fill="currentColor" />
    </svg>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" {...base} {...props}>
      <path d="M2 3.5h12M2 8h12M2 12.5h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" {...base} {...props}>
      <path
        d="M4.5 9.5 10 4M5.5 3.5H10.5V8.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SortIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" {...base} {...props}>
      <path
        d="M4 7h10M4 12h7M4 17h4M18 5v14M15 16l3 3 3-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" {...base} {...props}>
      <path d="m3.5 5.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 14 14" {...base} {...props}>
      <path d="m3 7.5 2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" {...base} {...props}>
      <path d="M3.5 10.5 12 3.5l8.5 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 9v10.5h13V9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 19.5v-5h4v5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="9" cy="8" r="3.5" stroke="currentColor" />
      <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" stroke="currentColor" strokeLinecap="round" />
      <circle cx="17" cy="9" r="2.6" stroke="currentColor" />
      <path d="M17.5 14.6c2.3.3 3.8 1.9 4.2 4.4" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" {...base} {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  );
}
