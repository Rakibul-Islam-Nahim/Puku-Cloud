import { Hono } from "hono";
import { z } from "zod";
import { json, err } from "../util/json.ts";
import { ulid } from "../util/ulid.ts";
import type { Env, Variables } from "../types/env.ts";

export const orgRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateOrg = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(64),
});

// POST /v1/orgs  — create an org and make the caller its owner.
orgRoutes.post("/orgs", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const body = CreateOrg.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);
  const now = Math.floor(Date.now() / 1000);
  const id = ulid("org");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)`
      ).bind(id, body.data.slug, body.data.name, now),
      c.env.DB.prepare(
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)`
      ).bind(id, user.id, now),
    ]);
  } catch (e) {
    return err(409, "conflict", (e as Error).message);
  }
  c.set("org", { id, slug: body.data.slug });
  return json({ id, slug: body.data.slug, name: body.data.name }, { status: 201 });
});

// GET /v1/orgs  — list orgs the caller belongs to.
orgRoutes.get("/orgs", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const rows = await c.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, m.role
       FROM orgs o JOIN org_members m ON m.org_id = o.id
       WHERE m.user_id = ?1 ORDER BY o.slug`
  ).bind(user.id).all();
  return json({ orgs: rows.results });
});

// GET /v1/orgs/:id
orgRoutes.get("/orgs/:id", async (c) => {
  const row = await c.env.DB.prepare(`SELECT id, slug, name, created_at FROM orgs WHERE id = ?1`)
    .bind(c.req.param("id")).first();
  if (!row) return err(404, "not_found", "org not found");
  return json(row);
});

// POST /v1/orgs/:id/members
const AddMember = z.object({ user_id: z.string(), role: z.enum(["admin", "member"]).default("member") });
orgRoutes.post("/orgs/:id/members", async (c) => {
  const body = AddMember.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`
  ).bind(c.req.param("id"), body.data.user_id, body.data.role, now).run();
  return json({ ok: true });
});

// POST /v1/orgs/invites/:token/accept
orgRoutes.post("/orgs/invites/:token/accept", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const now = Math.floor(Date.now() / 1000);
  const inv = await c.env.DB.prepare(
    `SELECT org_id, role, expires_at, accepted_at FROM org_invites WHERE token = ?1`
  ).bind(c.req.param("token")).first<{ org_id: string; role: string; expires_at: number; accepted_at: number | null }>();
  if (!inv) return err(404, "not_found", "invite not found");
  if (inv.expires_at < now) return err(410, "gone", "invite expired");
  if (inv.accepted_at) return err(409, "conflict", "invite already accepted");
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE org_invites SET accepted_at = ?1 WHERE token = ?2`).bind(now, c.req.param("token")),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(inv.org_id, user.id, inv.role, now),
  ]);
  return json({ ok: true, org_id: inv.org_id });
});

// GET /v1/me  — who am I, what orgs am I in?
orgRoutes.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const orgs = await c.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, m.role
       FROM orgs o JOIN org_members m ON m.org_id = o.id
       WHERE m.user_id = ?1`
  ).bind(user.id).all();
  return json({ user, orgs: orgs.results });
});
