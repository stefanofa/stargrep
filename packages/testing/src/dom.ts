// React DOM picks its event handling from the globals it finds when it loads, and Bun evaluates CommonJS such as React
// DOM before any test module body runs. Registering happy-dom while a `.test.tsx` file loads, before its imports, gives
// React a browser. Other test files keep Bun's globals.
Bun.plugin({
  name: "happy-dom for .test.tsx",
  setup(build) {
    build.onLoad({ filter: /\.test\.tsx$/ }, async ({ path }) => {
      const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
      if (!GlobalRegistrator.isRegistered) {
        // TanStack DB calls unref() on timer handles that are objects, and happy-dom's handles are objects without it.
        const timers = { setTimeout, clearTimeout, setInterval, clearInterval };
        GlobalRegistrator.register({ url: "http://localhost/" });
        Object.assign(globalThis, timers);
      }
      return { contents: await Bun.file(path).text(), loader: "tsx" };
    });
  },
});
