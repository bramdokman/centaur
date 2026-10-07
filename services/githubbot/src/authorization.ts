import type { GithubbotOptions } from "./types";

/**
 * Authorization gate for the conversational (comment) path. A comment that
 * @-mentions the bot drives an agent turn in a write-capable sandbox and posts a
 * transcript back, so only sufficiently-trusted authors may trigger it —
 * otherwise any commenter (anyone on a public repo) could steer the agent and
 * read back its tool output. The lifecycle paths (assignment, trigger label,
 * review-request) are gated by GitHub permissions, so this applies to comment
 * mentions and their follow-ups — plus issue hand-offs whose sender is the
 * issue's own author (issue templates apply labels/assignees for anyone; see
 * isIssueHandOffSenderAllowed).
 *
 * GitHub stamps every comment with an `author_association` (OWNER / MEMBER /
 * COLLABORATOR / CONTRIBUTOR / FIRST_TIME_CONTRIBUTOR / NONE / …). We trust the
 * collaborator-and-up set by default; a deployment can widen or narrow it, and
 * the sentinel "*" allows everyone (e.g. a fully-private repo where every
 * commenter is already trusted). Webhooks stamp private org members CONTRIBUTOR,
 * so the async gate (isActorAllowed) also lets in anyone whose repository
 * permission is triage or higher.
 */
export const DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
] as const;

const ALLOW_ALL = "*";

/** Pull `author_association` out of the adapter's raw comment message. */
export function authorAssociationFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const comment = (raw as { comment?: unknown }).comment;
  if (!comment || typeof comment !== "object") return undefined;
  const value = (comment as { author_association?: unknown }).author_association;
  return typeof value === "string" ? value : undefined;
}

/** Normalize the configured allowlist, defaulting when unset or empty. */
export function resolveAllowedAuthorAssociations(
  configured: readonly string[] | undefined,
): string[] {
  const list = (configured ?? DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.toUpperCase());
  return list.length ? list : [...DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS];
}

/**
 * Whether a comment's author is allowed to drive a turn. Fails closed: an
 * association we can't read (an unexpected payload shape) is treated as
 * untrusted rather than waved through.
 */
export function isCommentAuthorAllowed(
  raw: unknown,
  options: Pick<GithubbotOptions, "allowedAuthorAssociations">,
): boolean {
  const allowed = resolveAllowedAuthorAssociations(
    options.allowedAuthorAssociations,
  );
  if (allowed.includes(ALLOW_ALL)) return true;
  const association = authorAssociationFromRaw(raw);
  if (!association) return false;
  return allowed.includes(association.toUpperCase());
}

/**
 * Repository roles that may hand work to the bot when the payload's
 * `author_association` doesn't already say so.
 */
const TRIAGE_OR_HIGHER_ROLES = new Set(["triage", "write", "maintain", "admin"]);
const PERMISSION_ALLOWED_TTL_MS = 10 * 60 * 1000;
const PERMISSION_DENIED_TTL_MS = 60 * 1000;

type PermissionOctokit = {
  rest: {
    repos: {
      getCollaboratorPermissionLevel?: (input: {
        owner: string;
        repo: string;
        username: string;
      }) => Promise<{ data: unknown }>;
    };
  };
};

type CacheEntry = { allowed: boolean; expiresAtMs: number };
// Keyed per Octokit instance so two adapters (or two tests) never share entries.
const permissionCaches = new WeakMap<object, Map<string, CacheEntry>>();

/** Whether a permission-level response grants triage access or more. */
export function permissionGrantsTriage(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const record = data as {
    permission?: unknown;
    role_name?: unknown;
    user?: { permissions?: Record<string, unknown> } | null;
  };
  const role = typeof record.role_name === "string" ? record.role_name.toLowerCase() : "";
  if (TRIAGE_OR_HIGHER_ROLES.has(role)) return true;
  // Custom repository roles carry their own role_name; the boolean permission
  // map still says what they can do.
  const perms = record.user?.permissions;
  if (perms && (perms.triage === true || perms.push === true || perms.maintain === true || perms.admin === true)) {
    return true;
  }
  // `permission` is the legacy level: admin/write/read/none (maintain->write).
  const legacy = typeof record.permission === "string" ? record.permission.toLowerCase() : "";
  return legacy === "admin" || legacy === "write";
}

/**
 * Whether `login` has triage (or higher) access to `owner/repo`, from
 * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Cached in
 * memory (10 min allowed, 1 min denied). Fails closed: a lookup error denies
 * and is not cached.
 */
export async function hasRepoTriageAccess(
  octokit: unknown,
  owner: string,
  repo: string,
  login: string,
): Promise<boolean> {
  const client = octokit as PermissionOctokit | null | undefined;
  const lookup = client?.rest?.repos?.getCollaboratorPermissionLevel;
  if (!client || typeof lookup !== "function") return false;
  let cache = permissionCaches.get(client);
  if (!cache) {
    cache = new Map();
    permissionCaches.set(client, cache);
  }
  const key = `${owner}/${repo}:${login}`.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.allowed;
  try {
    const { data } = await lookup.call(client.rest.repos, { owner, repo, username: login });
    const allowed = permissionGrantsTriage(data);
    cache.set(key, {
      allowed,
      expiresAtMs: now + (allowed ? PERMISSION_ALLOWED_TTL_MS : PERMISSION_DENIED_TTL_MS),
    });
    return allowed;
  } catch {
    cache.delete(key);
    return false;
  }
}

/**
 * The human trust gate shared by every path that acts on what a person wrote or
 * did (comment mentions and follow-ups, body mentions, issue hand-offs by the
 * issue's own author).
 *
 * First the payload's `author_association` against the allowlist. That value
 * is not reliable for *private* org members: GitHub's webhooks often stamp them
 * CONTRIBUTOR (or NONE) even when they are org admins. So when the association
 * isn't allowed, fall back to the person's actual repository permission and
 * allow triage or higher. An outside contributor (read access at most) is still
 * refused, so an issue template that applies the trigger label can't start work
 * for them. Fails closed when the login or repo is unknown.
 */
export async function isActorAllowed(
  input: {
    association: string | undefined;
    login: string | undefined;
    owner: string | undefined;
    repo: string | undefined;
  },
  ctx: {
    octokit: unknown;
    options: Pick<GithubbotOptions, "allowedAuthorAssociations">;
  },
): Promise<boolean> {
  const allowed = resolveAllowedAuthorAssociations(ctx.options.allowedAuthorAssociations);
  if (allowed.includes(ALLOW_ALL)) return true;
  const association = input.association?.toUpperCase();
  if (association && allowed.includes(association)) return true;
  if (!input.login || !input.owner || !input.repo) return false;
  return hasRepoTriageAccess(ctx.octokit, input.owner, input.repo, input.login);
}
