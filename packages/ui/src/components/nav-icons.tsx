import { base, type IconProps } from "./icon-base.ts";

// The places in the phone's tab bar. Their own module, since the tab bar ships in the landing entry and a module shared
// with the stars engine ships whole there, every icon the engine uses with it.
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
