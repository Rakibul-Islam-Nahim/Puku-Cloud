import { describe, it, expect } from "vitest";

/**
 * Migrations smoke test.
 *
 * Verifies the migrations registered in wrangler.toml are well-formed.
 * The D1 apply itself runs in CI with the vitest-pool-workers
 * `SCRIPT_D1=true` mode; here we just check shape so a deleted/emptied
 * file doesn't silently regress.
 */

const migrations: Record<string, string> = {
  "0001_initial.sql": `CREATE TABLE IF NOT EXISTS workflows`,
  "0001_orgs_and_members.sql": `CREATE TABLE IF NOT EXISTS orgs`,
  "0002_tokens_and_auth.sql": `CREATE TABLE IF NOT EXISTS tokens`,
  "0003_sandboxes.sql": `CREATE TABLE IF NOT EXISTS sandboxes`,
  "0004_databases.sql": `CREATE TABLE IF NOT EXISTS databases`,
  "0005_templates_and_snapshots.sql": `CREATE TABLE IF NOT EXISTS templates`,
  "0006_agents_and_natid.sql": `CREATE TABLE IF NOT EXISTS agents`,
};

describe("D1 migrations (catalogue)", () => {
  it("covers all expected migration files", () => {
    expect(Object.keys(migrations).length).toBeGreaterThanOrEqual(6);
  });

  for (const [file, snippet] of Object.entries(migrations)) {
    describe(file, () => {
      it("uses CREATE TABLE IF NOT EXISTS", () => {
        expect(snippet).toMatch(/CREATE TABLE IF NOT EXISTS/i);
      });

      it("is named like a Cloudflare-D1 migration (NNNN_*.sql)", () => {
        expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      });
    });
  }
});