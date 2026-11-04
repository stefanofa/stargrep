import { Button } from "@stargrep/ui";
import { type ComponentProps, useState } from "react";
import { signIn } from "../lib/auth-client.ts";
import { GitHubMark } from "./github-mark.tsx";

export function SignInButton({
  label = "Sign in with GitHub",
  ...props
}: { label?: string } & Pick<ComponentProps<typeof Button>, "variant" | "size" | "className">) {
  const [pending, setPending] = useState(false);
  const start = () => {
    setPending(true);
    signIn().catch(() => setPending(false));
  };
  return (
    <Button variant="ghost" {...props} disabled={pending} onClick={start}>
      <GitHubMark className="size-4" />
      {label}
    </Button>
  );
}
