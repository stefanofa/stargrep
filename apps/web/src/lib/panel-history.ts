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
