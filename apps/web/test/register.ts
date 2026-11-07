import "./client-branch.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// TanStack DB calls unref() on timer handles that are objects, and happy-dom's handles are objects without it.
const timers = { setTimeout, clearTimeout, setInterval, clearInterval };
GlobalRegistrator.register({ url: "http://localhost/" });
Object.assign(globalThis, timers);
