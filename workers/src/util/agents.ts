/**
 * Pick an agent URL from PUKUCLOUD_AGENT_URLS.
 *
 * In the current Go API, multi-node scheduling uses `internal/scheduler`
 * (capacity scoring, leases). On Workers we do the same thing in TS via
 * a `GET /v1/internal/agents/capacity` probe — for v1 we round-robin.
 */
export function listAgents(env: { PUKUCLOUD_AGENT_URLS: string }): string[] {
  return env.PUKUCLOUD_AGENT_URLS.split(",").map((s) => s.trim()).filter(Boolean);
}

export function pickAgent(env: { PUKUCLOUD_AGENT_URLS: string }, key?: string): string {
  const agents = listAgents(env);
  if (agents.length === 0) throw new Error("PUKUCLOUD_AGENT_URLS is empty");
  if (!key) return agents[0]!;
  // Stable hash → index. Same key always lands on same agent.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % agents.length;
  return agents[idx]!;
}
