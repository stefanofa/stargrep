import { DurableObject, env } from "cloudflare:workers";
import type { RemoteRequest } from "@stargrep/github/token-gate";

const generated = await import(env.RUNTIME_ENTRY);

// Vitest checks RPC methods on the prototype, while Alchemy exposes them through an instance Proxy.
export class GitHubGate extends DurableObject {
  private readonly gate = new generated.GitHubGate(this.ctx, this.env);
  execute(request: RemoteRequest, token?: string): Promise<unknown> {
    return this.gate.execute(request, token);
  }
}
export class UserGitHubGate extends DurableObject {
  private readonly gate = new generated.UserGitHubGate(this.ctx, this.env);
  execute(request: RemoteRequest, token: string): Promise<unknown> {
    return this.gate.execute(request, token);
  }
}
export default generated.default;
