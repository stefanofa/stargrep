const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// The day of a star, such as Nov 6, 2026, in UTC as stargrep stores it. Its own module, so a page that says when someone
// last starred, such as the person tile on the taste page, doesn't load the search's presentation code.
export const starredOn = (iso: string) => dateFormat.format(Date.parse(iso));
