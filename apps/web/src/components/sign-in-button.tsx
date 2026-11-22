import { buttonVariants, cn } from "@stargrep/ui";
import { type ReactNode, useState } from "react";
import { signIn } from "../lib/auth-client.ts";
import { GitHubMark } from "./github-mark.tsx";

// A plain button on the shared variants rather than the UI kit's Button, so the header can ask for sign-in without
// bringing Base UI into the landing chunk.
export function SignInButton({
  label = "sign in with GitHub",
  mark = true,
  markClassName,
  variant = "ghost",
  size,
  className,
}: {
  label?: ReactNode;
  mark?: boolean;
  markClassName?: string;
  variant?: "primary" | "ghost";
  size?: "default" | "lg";
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const start = () => {
    setPending(true);
    signIn().catch(() => setPending(false));
  };
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={pending}
      onClick={start}
    >
      {mark && <GitHubMark className={markClassName ?? "size-4"} />}
      {label}
    </button>
  );
}
