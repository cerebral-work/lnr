import { notFoundError } from "../lib/errors.js";
import type { LinearClient, Team } from "@linear/sdk";
import { drainConnection } from "../lib/paginate.js";
import { withRetry } from "../lib/retry.js";

export interface TeamSummary {
  id: string;
  key: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
}

/**
 * Resolve a {@link Team} by its key (e.g. `"CER"`), case-insensitively.
 *
 * Domain logic shared by everything that takes a `--team <key>` (issues,
 * projects). Throws a clear error rather than returning `undefined` so callers
 * can let it bubble to the top-level handler. Moved here from `lib/resolve.ts`
 * so the CLI and the MCP server share one team resolver.
 */
export async function resolveTeamByKey(
  client: LinearClient,
  key: string,
): Promise<Team> {
  const k = key.trim();
  const teams = await withRetry(() => client.teams({ filter: { key: { eqIgnoreCase: k } } }));
  const team = teams.nodes[0];
  if (!team) {
    const keys = await listTeamKeys(client);
    throw notFoundError(
      `no team with key ${JSON.stringify(k)} — available team keys: ${keys.join(", ") || "(none visible)"}; check Linear Settings → Teams.`,
    );
  }
  return team;
}

/** Exhaust the connection so hints do not omit teams beyond the first page. */
export async function listTeamKeys(client: LinearClient): Promise<string[]> {
  const firstPage = await withRetry(() => client.teams({ first: 100 }));
  const teams = await drainConnection(firstPage);
  return [...new Set(teams.map((t) => t.key))].sort();
}

/**
 * List all accessible teams with summary metadata, sorted by key.
 */
export async function listTeams(client: LinearClient): Promise<TeamSummary[]> {
  const firstPage = await withRetry(() => client.teams({ first: 100 }));
  const teams = await drainConnection(firstPage);
  return teams
    .map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      displayName: t.displayName ?? null,
      description: t.description ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Resolve a team by key, name, or UUID case-insensitively.
 */
export async function resolveTeam(
  client: LinearClient,
  ref: string,
): Promise<TeamSummary> {
  const r = ref.trim().toLowerCase();
  const allTeams = await listTeams(client);
  const matched = allTeams.find(
    (t) =>
      t.key.toLowerCase() === r ||
      t.name.toLowerCase() === r ||
      (t.displayName && t.displayName.toLowerCase() === r) ||
      t.id.toLowerCase() === r,
  );
  if (!matched) {
    const keys = allTeams.map((t) => t.key);
    throw notFoundError(
      `no team matching ${JSON.stringify(ref.trim())} — available team keys: ${keys.join(", ") || "(none visible)"}; check Linear Settings → Teams.`,
    );
  }
  return matched;
}

export interface CreateTeamParams {
  key: string;
  name: string;
  description?: string;
}

export interface CreatedTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

/**
 * Create a Linear team by key and name (idempotent if key already exists).
 */
export async function createTeam(
  client: LinearClient,
  params: CreateTeamParams,
): Promise<CreatedTeam> {
  const k = params.key.trim().toUpperCase();
  const existing = await withRetry(() => client.teams({ filter: { key: { eqIgnoreCase: k } } }));
  if (existing.nodes[0]) {
    const t = existing.nodes[0];
    return {
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description ?? null,
    };
  }
  const payload = await withRetry(() =>
    client.createTeam({
      key: k,
      name: params.name.trim(),
      ...(params.description ? { description: params.description } : {}),
    }),
  );
  if (!payload.success) {
    throw new Error("Linear reported the team create did not succeed.");
  }
  const team = await payload.team;
  if (!team) {
    throw new Error("team created but the payload returned no team.");
  }
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description ?? null,
  };
}

