import { useState } from "react";
import { api } from "./rpc.ts";

// The opt-in as the account menu shows it. The menu reads it on its first open, so a page load asks for nothing.
export type MonthlyPicks =
  | { readonly kind: "unread" }
  | { readonly kind: "reading" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "shown"; readonly optedIn: boolean }
  | { readonly kind: "saving"; readonly optedIn: boolean }
  | { readonly kind: "rolled-back"; readonly optedIn: boolean };

export const useMonthlyPicks = () => {
  const [picks, setPicks] = useState<MonthlyPicks>({ kind: "unread" });

  const read = () => {
    if (picks.kind !== "unread" && picks.kind !== "unreadable") return;
    setPicks({ kind: "reading" });
    api()
      .monthlyPicks()
      .then(
        ({ optedIn }) => setPicks({ kind: "shown", optedIn }),
        () => setPicks({ kind: "unreadable" }),
      );
  };

  // The switch moves at once and moves back when the save fails.
  const set = (optedIn: boolean) => {
    if (picks.kind !== "shown" && picks.kind !== "rolled-back") return;
    setPicks({ kind: "saving", optedIn });
    api()
      .setMonthlyPicks({ optedIn })
      .then(
        (saved) => setPicks({ kind: "shown", optedIn: saved.optedIn }),
        () => setPicks({ kind: "rolled-back", optedIn: !optedIn }),
      );
  };

  return { picks, read, set };
};
