import { Button } from "@stargrep/ui";
import { type ComponentProps, type ReactNode, useState } from "react";
import { signIn } from "../lib/auth-client.ts";
import { GitHubMark } from "./github-mark.tsx";

export function SignInButton({
  label = "Sign in with GitHub",
  markClassName,
  ...props
}: { label?: ReactNode; markClassName?: string } & Pick<
  ComponentProps<typeof Button>,
  "variant" | "size" | "className"
>) {
  const [pending, setPending] = useState(false);
  const start = () => {
    setPending(true);
    signIn().catch(() => setPending(false));
  };
  return (
    <Button variant="ghost" {...props} disabled={pending} onClick={start}>
      <GitHubMark className={markClassName ?? "size-4"} />
      {label}
    </Button>
  );
}
