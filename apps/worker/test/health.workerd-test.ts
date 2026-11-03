import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("reports the Postgres and pgvector versions through Hyperdrive", async () => {
  const response = await exports.default.fetch("http://worker/health");
  expect(response.status).toBe(200);
  const body = await response.json<{ postgres: string; pgvector: string | null }>();
  expect(body.postgres).toMatch(/^PostgreSQL 17\.\d+/);
  expect(body.pgvector).toMatch(/^\d+\.\d+\.\d+$/);
});

it("answers 503 when Postgres is unreachable", async () => {
  const response = await exports.default.fetch("http://worker/health-unreachable");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Postgres health check failed" });
});
