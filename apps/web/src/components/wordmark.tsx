import { Link } from "@tanstack/react-router";

export function Wordmark() {
  return (
    <Link to="/" className="rounded-sm font-display text-3xl leading-none font-semibold tracking-snug text-foreground">
      stargrep
    </Link>
  );
}
