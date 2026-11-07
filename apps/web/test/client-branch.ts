import { mock } from "bun:test";
import * as start from "@tanstack/react-start";

// The browser build keeps only the client branch of an isomorphic function, and the source run as written always takes
// the server branch. A test of what the browser does takes the client branch too, and a server-only function throws.
const clientBranch = <F>(fn: F) => Object.assign(fn as object, { server: () => fn }) as F;
mock.module("@tanstack/react-start", () => ({
  ...start,
  createIsomorphicFn: () => ({ server: () => ({ client: clientBranch }), client: clientBranch }),
  createServerOnlyFn: () => () => {
    throw new Error("a server-only function ran in the browser");
  },
}));
