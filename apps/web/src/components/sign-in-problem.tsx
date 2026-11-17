import { Tile } from "@stargrep/ui";
import { SignInButton } from "./sign-in-button.tsx";

const problems: Record<string, { readonly heading: string; readonly detail: string }> = {
  access_denied: { heading: "you said no to github", detail: "stargrep saw nothing from your account" },
};

const failed = { heading: "sign-in didn't finish", detail: "github or stargrep hiccuped on the way back" };

export function SignInProblem({ error }: { error: string }) {
  const problem = problems[error] ?? failed;
  return (
    <Tile
      role="alert"
      className="flex flex-col gap-4 py-6 pr-6 pl-tile-lg sm:flex-row sm:items-center sm:justify-between sm:rounded-md"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-snug">{problem.heading}</h2>
        <p className="font-sans text-base text-secondary-foreground">{problem.detail}</p>
      </div>
      <SignInButton variant="primary" size="lg" label="Try again" />
    </Tile>
  );
}
