import { CliError } from "./lib/errors.js";
import { LinearClient } from "@linear/sdk";

/** Prefix of a 1Password secret reference, which only `op run` / `op read` resolve. */
const OP_REFERENCE_PREFIX = "op://";

/**
 * Read `LINEAR_API_KEY` from the environment, rejecting an unresolved
 * 1Password reference before any network call (specs/0007, CER-2926). The
 * value never appears in the error.
 */
export function apiKeyFromEnv(): string {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new CliError("auth", "LINEAR_API_KEY is not set.", "Set LINEAR_API_KEY in the environment; see README.md → Authentication.");
  }
  if (apiKey.trim().startsWith(OP_REFERENCE_PREFIX)) {
    throw new CliError("auth", "LINEAR_API_KEY is an unresolved 1Password reference (op://…), not a Linear API key.",
      "Run lnr through `opr` (or `op run -- lnr …`) so the reference is resolved, or export the resolved key.");
  }
  return apiKey;
}

/**
 * Build a {@link LinearClient} from the `LINEAR_API_KEY` environment variable.
 *
 * The key is read from the environment only — provision it however you like (a
 * secret manager rendered into your shell, an untracked `.env`, etc.). This CLI
 * never stores, prints, or persists the key; it only reads it from the process
 * environment at call time.
 */
export function makeClient(): LinearClient {
  return new LinearClient({ apiKey: apiKeyFromEnv() });
}

/**
 * Build a {@link LinearClient} from an OAuth `access_token` (app or user actor).
 *
 * The additive OAuth path (CER-1148 / T13). Accepts an already-minted token
 * (from `linearctl auth client-credentials`, `auth exchange-code`, or the
 * pre-exchanged `dev_app_token` / `dev_user_token` 1Password fields). The
 * caller is responsible for token lifecycle; this fn only wires the token
 * into the SDK.
 *
 * The token is never stored, cached, logged, or printed; it lives only for
 * the lifetime of this process. On 401, mint a fresh token and rebuild.
 */
export function makeOAuthClient(accessToken: string): LinearClient {
  return new LinearClient({ accessToken });
}

/**
 * Resolve auth at call time: prefer an explicit OAuth access token when one is
 * available, falling back to the env-only `LINEAR_API_KEY` contract existing
 * commands rely on. Returns the client + which path was taken, so callers
 * (e.g. `auth whoami` verification) can reason about the actor.
 */
export type ResolvedAuth =
  | { kind: "oauth"; client: LinearClient; accessToken: string }
  | { kind: "apiKey"; client: LinearClient };

export function resolveAuth(accessToken?: string): ResolvedAuth {
  if (accessToken) {
    return { kind: "oauth", client: makeOAuthClient(accessToken), accessToken };
  }
  return { kind: "apiKey", client: makeClient() };
}
