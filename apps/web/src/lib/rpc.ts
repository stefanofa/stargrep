import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient, InferContractRouterOutputs } from "@orpc/contract";
import type { contract } from "@stargrep/api/contract";
import type { WireCode } from "@stargrep/api/errors";

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

// The contract's code for a failure the API answered, or undefined for any other failure, such as a dropped connection.
// Only an error the contract defines arrives marked as defined.
export const wireCode = (error: unknown): WireCode | undefined =>
  error instanceof ORPCError && error.defined ? (error.code as WireCode) : undefined;
