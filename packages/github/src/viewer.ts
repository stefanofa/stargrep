import * as Schema from "effect/Schema";
import { toOwner, User, userFields } from "./owner.ts";

export const query = `query Viewer {
  viewer {
    __typename
    ${userFields}
  }
}`;

export const Data = Schema.Struct({ viewer: User });

export const toViewer = (viewer: typeof User.Type) => {
  const { account, starredTotal } = toOwner(viewer);
  return { account, starredCount: starredTotal };
};
export type SignedInViewer = ReturnType<typeof toViewer>;
