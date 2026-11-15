import { zone } from "@stargrep/worker/domain";

// Only prod's own host is for search engines. Previews serve on the same zone, so a page anywhere else says noindex.
export const indexable = (url: string) => new URL(url).hostname === zone;

export const withRobots = (request: Request, response: Response) => {
  if (!indexable(request.url)) response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
};
