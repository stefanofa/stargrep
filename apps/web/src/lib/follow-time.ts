// Times as the follows pages say them. Days are UTC days, as the rest of the site's dates are, so the server and the
// browser render the same words. Plain Date math, because topic pages load no Effect.
const hour = 3_600_000;
const day = 24 * hour;

const dayStart = (millis: number) => Math.floor(millis / day) * day;
const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" });
const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

const daysBack = (iso: string, at: number) => Math.round((dayStart(at) - dayStart(Date.parse(iso))) / day);

// "2 hours ago", "yesterday", "Wednesday", then "Nov 18".
export const when = (iso: string, at: number) => {
  const millis = Date.parse(iso);
  const minutes = Math.max(0, Math.floor((at - millis) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  }
  const days = daysBack(iso, at);
  if (days <= 1) return "yesterday";
  if (days < 7) return weekday.format(millis);
  return date.format(millis);
};

// "Nov 18".
export const on = (iso: string) => date.format(Date.parse(iso));

export type DayGroup = "today" | "yesterday" | "this week" | "earlier";

export const dayGroup = (iso: string, at: number): DayGroup => {
  const days = daysBack(iso, at);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "this week";
  return "earlier";
};

export const withinWeek = (iso: string, at: number) => at - Date.parse(iso) < 7 * day;

// "20 min ago", "3 hours ago", "2 days ago", for when stargrep last found someone's stars current.
export const checkedAgo = (iso: string, at: number) => {
  const minutes = Math.max(0, Math.floor((at - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hours ago`;
  const days = Math.floor(minutes / (24 * 60));
  return days === 1 ? "a day ago" : `${days} days ago`;
};

// "5 weeks ago", for the newest star of a quiet month.
export const weeksAgo = (iso: string, at: number) => {
  const days = Math.floor((at - Date.parse(iso)) / day);
  if (days < 14) return `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
};
