import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    databaseName: string;
  }
}
