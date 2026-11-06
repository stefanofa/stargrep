import { type ComponentType, lazy } from "react";

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

type Part<P> = { readonly default: ComponentType<P> };

// React's lazy reads a thenable that resolves while it subscribes as already settled, so once the loader has loaded the
// engine, the server renders the whole page in one pass and the client renders it with no suspense. A Promise resolves
// a tick later, which would suspend.
// biome-ignore lint/suspicious/noThenProperty: React's lazy needs a thenable that calls back synchronously.
const settled = <P>(part: Part<P>) => ({ then: (resolve: (value: Part<P>) => void) => resolve(part) });

const part = <P>(pick: (engine: Engine) => ComponentType<P>) =>
  lazy(() =>
    loaded === undefined
      ? loadEngine().then((engine) => ({ default: pick(engine) }))
      : (settled({ default: pick(loaded) }) as unknown as Promise<Part<P>>),
  );

export const Stars = part((engine) => engine.Stars);

export const HeaderControls = part((engine) => engine.HeaderControls);
