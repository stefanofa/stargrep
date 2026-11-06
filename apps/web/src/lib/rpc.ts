import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient, InferContractRouterOutputs } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";

type Outputs = InferContractRouterOutputs<typeof contract>;
export type Viewer = Outputs["viewer"];
export type LibraryRepo = Outputs["library"]["repos"][number];
export type SearchResult = Outputs["search"]["results"][number];
export type SyncStatus = Outputs["syncStatus"];
export type PublicConfig = Outputs["config"];
export type EnrichmentProgress = SyncStatus["enrichment"];
export type OwnerType = NonNullable<LibraryRepo["ownerType"]>;
export type Client = ContractRouterClient<typeof contract>;

let client: Client | undefined;

export const api = () => {
  client ??= createORPCClient(new RPCLink({ url: "/rpc", origin: location.origin }));
  return client;
};

export const wireCode = (error: unknown): string | undefined => (error instanceof ORPCError ? error.code : undefined);

export const signedOut = (error: unknown) => wireCode(error) === "UNAUTHORIZED";
