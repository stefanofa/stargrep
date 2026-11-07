import { renderRegistrySql } from "../src/registry-sql.ts";

await Bun.write(new URL("../src/registry.sql", import.meta.url), renderRegistrySql());
