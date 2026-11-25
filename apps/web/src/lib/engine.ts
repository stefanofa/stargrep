import { type ComponentType, createElement, lazy, useState } from "react";

type Engine = typeof import("../components/stars.tsx");

let loaded: Engine | undefined;
let loading: Promise<Engine> | undefined;

export const loadEngine = () => {
  loading ??= import("../components/stars.tsx").then((engine) => {
    loaded = engine;
    return engine;
  });
  return loading;
};

// The server and a navigation in the browser render after the page loader has loaded the engine, so they render the
// engine's component itself and nothing suspends. Hydration starts before the engine chunk arrives, so it renders the
// lazy component, which suspends, and React keeps the server's HTML until the chunk lands. Each mount picks once, so a
// part never changes type under its state.
const part = <P extends object>(pick: (engine: Engine) => ComponentType<P>) => {
  const Lazy = lazy(() => loadEngine().then((engine) => ({ default: pick(engine) })));
  return function Part(props: P) {
    const [Component] = useState<ComponentType<P>>(() => (loaded === undefined ? Lazy : pick(loaded)));
    return createElement(Component, props);
  };
};

export const Stars = part((engine) => engine.Stars);

export const SignInProblem = part((engine) => engine.SignInProblem);

export const Landing = part((engine) => engine.Landing);
