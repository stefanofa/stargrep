const day = 86_400_000;
const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const yearOf = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "UTC" });

// The day of a star, such as Nov 6, 2026, in UTC as stargrep stores it. Its own module, so a page that says when someone
// last starred, such as the person tile on the taste page, doesn't load the search's presentation code.
export const starredOn = (iso: string) => dateFormat.format(Date.parse(iso));

// When the last star was, in UTC days: today, yesterday, a day this year such as Aug 2, or a day with its year.
export const lastStarredOn = (iso: string, at: number) => {
  const when = Date.parse(iso);
  const days = Math.floor(at / day) - Math.floor(when / day);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return yearOf.format(when) === yearOf.format(at) ? shortDay.format(when) : dateFormat.format(when);
};
