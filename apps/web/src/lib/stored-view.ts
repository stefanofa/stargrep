import { isView, type View } from "@stargrep/ui";
import { useCallback, useEffect, useState } from "react";

const storageKey = "stargrep:view";

const readStoredView = (): View | undefined => {
  try {
    const stored = localStorage.getItem(storageKey);
    return isView(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
};

// The view a visitor last picked, kept in this browser. The server renders the fallback and the stored view lands
// after hydration.
export function useStoredView(fallback: View = "tiles") {
  const [view, setView] = useState<View>(fallback);
  useEffect(() => {
    const stored = readStoredView();
    if (stored) setView(stored);
  }, []);
  const update = useCallback((next: View) => {
    setView(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {}
  }, []);
  return [view, update] as const;
}
