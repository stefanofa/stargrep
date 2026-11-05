import { Pip, type PipPose } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";

export function Wordmark({ pose = "idle" }: { pose?: PipPose }) {
  return (
    <Link
      to="/"
      className="flex items-center gap-1.5 rounded-sm font-display text-3xl leading-none font-semibold tracking-snug text-foreground"
    >
      <Pip pose={pose} size={40} className="max-sm:size-[30px]" />
      stargrep
    </Link>
  );
}
