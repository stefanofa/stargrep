import type { DurableObject } from "cloudflare:workers";
import type { RemoteRequest } from "@stargrep/github/token-gate";

declare class Gate extends DurableObject {
  execute(request: RemoteRequest, token?: string): Promise<unknown>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      RUNTIME_ENTRY: string;
      Database: Hyperdrive;
      Readmes: R2Bucket;
      GitHubGate: DurableObjectNamespace<Gate>;
      UserGitHubGate: DurableObjectNamespace<Gate>;
    }
  }
}
