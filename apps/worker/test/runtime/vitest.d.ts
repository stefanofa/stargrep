import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    adminUrl: string;
    databaseName: string;
  }
}
