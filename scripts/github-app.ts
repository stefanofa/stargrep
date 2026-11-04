import { parseArgs } from "node:util";
import { $ } from "bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";

const { values } = parseArgs({
  options: { org: { type: "string" }, env: { type: "string", multiple: true, default: ["production"] } },
});

const manifest = await Bun.file(new URL("../.github/app-manifest.json", import.meta.url)).json();
const state = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const newAppUrl = values.org
  ? `https://github.com/organizations/${encodeURIComponent(values.org)}/settings/apps/new`
  : "https://github.com/settings/apps/new";

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const form = (redirectUrl: string) => `<!doctype html>
<form method="post" action="${newAppUrl}?state=${state}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify({ ...manifest, redirect_url: redirectUrl }))}">
  <button>Create the Stargrep GitHub App</button>
</form>`;

const Conversion = Schema.Struct({ html_url: Schema.String, client_id: Schema.String, client_secret: Schema.String });
type Conversion = typeof Conversion.Type;

const convert = (code: string) =>
  HttpClient.execute(
    HttpClientRequest.post(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`).pipe(
      HttpClientRequest.accept("application/vnd.github+json"),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Conversion)),
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  );

const store = async ({ client_id, client_secret }: Conversion) => {
  await $`gh variable set STARGREP_GITHUB_APP_CLIENT_ID --body ${client_id}`;
  for (const env of values.env) {
    await $`gh secret set STARGREP_GITHUB_APP_CLIENT_SECRET --env ${env} < ${new Response(client_secret)}`;
  }
};

// GitHub hands out the client secret once, so a failed store has to say how to get a new one.
const create = async (code: string) => {
  const app = await convert(code);
  await store(app).catch((cause: unknown) => {
    throw new Error(
      `The app exists at ${app.html_url}, but its credentials were not stored. Generate a new client secret in the app's settings and store it with: gh secret set STARGREP_GITHUB_APP_CLIENT_SECRET --env <env>`,
      { cause },
    );
  });
  return app.html_url;
};

const done = Promise.withResolvers<string>();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(form(`http://127.0.0.1:${server.port}/created`), {
        headers: { "content-type": "text/html" },
      });
    }
    const code = url.searchParams.get("code");
    if (url.pathname !== "/created" || url.searchParams.get("state") !== state || !code) {
      return new Response("Not found", { status: 404 });
    }
    const created = create(code);
    done.resolve(created);
    return created.then(
      () => new Response("The app exists and its credentials are stored. Close this tab."),
      () => new Response("Storing the app's credentials failed. The terminal says what to do.", { status: 500 }),
    );
  },
});

console.log(`Open http://127.0.0.1:${server.port}/ and press the button.`);
try {
  console.log(`Created ${await done.promise}`);
  console.log(
    `Set STARGREP_GITHUB_APP_CLIENT_ID as a repository variable and STARGREP_GITHUB_APP_CLIENT_SECRET in: ${values.env.join(", ")}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await server.stop();
}
