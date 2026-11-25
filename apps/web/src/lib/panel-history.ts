import { useNavigate, useRouter } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface HistoryState {
    // The history index of the page a click opened the repo panel over.
    readonly panelOver?: number;
  }
}

// A panel a click opened sits in its own history entry, right after the page it opened over, so closing it goes back
// to that page and Back never opens it again. Any other panel, such as one a shared link opened, closes in place.
export const closesBack = (state: { readonly panelOver?: number; readonly __TSR_index: number }) =>
  state.panelOver !== undefined && state.panelOver === state.__TSR_index - 1;

// The repo panel lives in ?repo=owner/name, so a link to a page can open it. Opening adds a history entry that names
// the page it opened over, which survives Forward and reloads as a component's own state would not, so Back closes it.
export function useRepoParam() {
  const navigate = useNavigate();
  const router = useRouter();
  const open = (repo: { readonly owner: string; readonly name: string }) =>
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, repo: `${repo.owner}/${repo.name}` }),
      state: { panelOver: router.state.location.state.__TSR_index },
    });
  const close = () => {
    if (closesBack(router.state.location.state)) router.history.back();
    else navigate({ to: ".", search: (previous) => ({ ...previous, repo: undefined }), replace: true });
  };
  return { open, close };
}
