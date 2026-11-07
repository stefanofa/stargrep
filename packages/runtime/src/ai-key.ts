import { apiKeyName } from "@stargrep/ai/gateway";
import { optionalSecret } from "./config.ts";

export const aiGatewayKey = optionalSecret(apiKeyName);
