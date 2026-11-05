declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./entry.ts");
  }
}

interface ImportMeta {
  glob<T>(
    patterns: string | ReadonlyArray<string>,
    options: { readonly query: string; readonly import: "default"; readonly eager: true },
  ): Record<string, T>;
}
