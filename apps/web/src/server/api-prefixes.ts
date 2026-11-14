import type { Transport } from "@stargrep/api/middleware/instrumentation";
import { basePath } from "@stargrep/auth/config";

// The paths the web Worker answers under before any page: each API transport, and Better Auth's sign-in API. Prod's zone
// rate limits exactly these, so the module imports nothing a deploy can't load.
export const apiPrefixes = {
  rest: "/api",
  rpc: "/rpc",
  mcp: "/mcp",
  auth: basePath,
} as const satisfies Record<Transport | "auth", string>;
