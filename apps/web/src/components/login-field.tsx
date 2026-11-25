import { buttonVariants, cn } from "@stargrep/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId } from "react";
import { loginPage, typedLogin, typedLoginParam } from "../lib/stars-route.ts";

// Whose stars to look at, by GitHub username. Before the page hydrates, the browser submits the form itself and / sends
// the login on to its page.
export function LoginField({ className }: { className?: string }) {
  const navigate = useNavigate();
  const field = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const login = typedLogin(String(new FormData(form).get(typedLoginParam) ?? ""));
    if (login === undefined) {
      form.reportValidity();
      return;
    }
    form.reset();
    navigate(loginPage(login));
  };
  return (
    <form
      action="/"
      method="get"
      onSubmit={submit}
      aria-label="Whose stars"
      className={cn(
        "flex h-13 items-center rounded-full bg-card pr-1.5 pl-[18px] font-sans text-[16px] leading-5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:h-15 sm:pr-2 sm:pl-6 sm:text-[19px] sm:leading-6",
        className,
      )}
    >
      <label htmlFor={field} className="text-muted-foreground select-none">
        github.com/<span className="sr-only">username</span>
      </label>
      <input
        id={field}
        name={typedLoginParam}
        placeholder="username"
        required
        pattern={String.raw`\s*@?[A-Za-z\d][A-Za-z\d\-]{0,38}\s*`}
        title="a GitHub username, such as octocat"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      <button
        type="submit"
        className={cn(buttonVariants({ size: "lg" }), "h-10 px-[18px] sm:h-11 sm:px-[22px] sm:text-[16px]")}
      >
        go
      </button>
    </form>
  );
}
