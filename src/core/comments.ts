import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { resolveAssignee } from "./issues.js";
import { notFoundError, usageError } from "../lib/errors.js";
import { scopedTeams } from "./issues-query.js";

export interface AuthorComment {
  at: string;
  author: string;
  issue: string;
  issueTitle: string;
  body: string;
  url: string;
}

const COMMENTS_QUERY = /* GraphQL */ `
  query CommentsByAuthor($filter: CommentFilter, $first: Int!, $after: String) {
    comments(filter: $filter, first: $first, after: $after) {
      nodes {
        createdAt
        body
        url
        user {
          displayName
        }
        issue {
          identifier
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * "What did <person> comment recently": ONE paginated comments query with
 * author + createdAt (+ optional team) filters — replaces the parent-scoped
 * MCP scan (138 issues, ~7 min, coverage-capped) this ticket documents.
 * See CER-1187.
 */
export async function commentsByAuthor(
  client: LinearClient,
  opts: { author: string; since: Date; teamKeys?: string[]; limit?: number },
): Promise<AuthorComment[]> {
  const userId = await resolveAssignee(client, opts.author);
  const teams = scopedTeams(opts.teamKeys);
  const filter = {
    user: { id: { eq: userId } },
    createdAt: { gte: opts.since },
    ...(teams ? { issue: { team: { key: { in: teams } } } } : {}),
  };

  type Vars = Record<string, unknown> & { first: number; after: string | null };
  const out: AuthorComment[] = [];
  const cap = opts.limit ?? 200;
  let after: string | null = null;
  do {
    const vars: Vars = { filter, first: Math.min(100, cap), after };
    const res = await withRetry(() =>
      client.client.rawRequest<
        {
          comments: {
            nodes: Array<{
              createdAt: string;
              body: string;
              url: string;
              user: { displayName: string } | null;
              issue: { identifier: string; title: string } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        Vars
      >(COMMENTS_QUERY, vars),
    );
    const page = res.data?.comments;
    if (!page) throw new Error("comments query returned no data");
    for (const n of page.nodes) {
      out.push({
        at: n.createdAt,
        author: n.user?.displayName ?? "—",
        issue: n.issue?.identifier ?? "—",
        issueTitle: n.issue?.title ?? "",
        body: n.body,
        url: n.url,
      });
    }
    after = page.pageInfo.hasNextPage && out.length < cap ? page.pageInfo.endCursor : null;
  } while (after);
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, cap);
}

/** Issue-scoped receipt lookup: one bounded page, never a workspace scan. */
export async function issueComments(
  client: LinearClient, id: string, opts: { limit?: number; after?: string } = {},
) {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw usageError("comment limit must be an integer between 1 and 100");
  }
  const result = await withRetry(() => client.client.rawRequest<{
    issue: { id: string; identifier: string; comments: {
      nodes: Array<{ id: string; body: string; url: string; createdAt: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    } } | null;
  }, Record<string, unknown>>(`query IssueComments($id: String!, $first: Int!, $after: String) {
    issue(id: $id) { id identifier comments(first: $first, after: $after) {
      nodes { id body url createdAt }
      pageInfo { hasNextPage endCursor }
    } }
  }`, { id, first: limit, after: opts.after ?? null }));
  const issue = result.data?.issue;
  if (!issue) throw notFoundError(`Issue '${id}' was not found.`);
  return { issue: { id: issue.id, identifier: issue.identifier },
    comments: issue.comments.nodes, pageInfo: issue.comments.pageInfo };
}
