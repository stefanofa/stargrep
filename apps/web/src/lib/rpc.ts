import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient, InferContractRouterOutputs } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";

type Outputs = InferContractRouterOutputs<typeof contract>;
export type Viewer = Outputs["viewer"];
export type LibraryRepo = Outputs["library"]["repos"][number];
export type SearchResult = Outputs["search"]["results"][number];
export type SyncStatus = Outputs["syncStatus"];
export type EnrichmentProgress = SyncStatus["enrichment"];
export type OwnerType = NonNullable<LibraryRepo["ownerType"]>;

let client: ContractRouterClient<typeof contract> | undefined;

export const api = () => {
  client ??= createORPCClient(new RPCLink({ url: "/rpc", origin: location.origin }));
  return client;
};

export const signedOut = (error: unknown) => error instanceof ORPCError && error.code === "UNAUTHORIZED";
