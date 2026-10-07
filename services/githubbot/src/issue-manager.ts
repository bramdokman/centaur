import { resolveAllowedAuthorAssociations } from "./authorization";
import { backgroundWaitUntil } from "./context";
import { hasLabel, isBotLogin, labelNames } from "./identity";
import { DEFAULT_ISSUE_PROMPT } from "./issue-prompt";
import type { PrManagerContext } from "./pr-manager";
import { reactWorkingOnSubject, settleSubjectReaction } from "./reactions";
import { runTurnStream, turnOutputChars } from "./turn";
import type {
  ForwardSessionInput,
  GithubbotApiMessage,
  GithubbotOptions,
  GithubbotTrace,
} from "./types";
import { errorMessage, noopLogger, nowMs, stringValue, traceLog } from "./utils";

/**
 * Issues, like PRs, are worked on assignment: assigning an issue to the bot is
 * the signal to pick it up. On the `issues` `assigned` webhook (when the bot is
 * among the assignees), the bot runs an autonomous work turn — read the issue,
 * implement a fix, and open a PR (self-assigning that PR so it then drives it to
 * merge via the PR-management flow). The methodology is the bundled
 * DEFAULT_ISSUE_PROMPT unless the deployment fully replaces it via
 * options.issuePrompt.
 *
 * The work runs on its own isolated session thread (`github-issue:{owner}/{repo}:
 * {n}`), kept separate from the issue's conversation thread so a work run never
 * shares a sandbox with chit-chat — but persistent per issue, so a re-assignment
 * builds on the prior attempt. The agent does all GitHub I/O via `gh`, so the bot
 * does not post through the adapter.
 */

// Reuse the PR manager's context shape (octokit + options + state + userName);
// the two managers share the same GitHub credentials and KV store.
type IssueManagerContext = PrManagerContext;

// Assignment webhooks are de-duplicated by delivery id for a week — long enough
// to cover GitHub's redelivery window without growing state unboundedly.
const ISSUE_WORK_DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ASSIGNED_CACHE_TTL_MS = 10 * 60 * 1000;
// Assignment + trigger label applied together arrive as two deliveries; within
// this window the second is folded into the first.
const ISSUE_TRIGGER_COALESCE_MS = 2 * 60 * 1000;

export function issueWorkThreadKey(
  owner: string,
  repo: string,
  n: number,
): string {
  return `github-issue:${owner}/${repo}:${n}`;
}

export type IssueTrigger = "assigned" | "labeled";

/**
 * Which hand-off (if any) an `issues` webhook is: `assigned` when the bot is
 * among the assignees after an assignment, `labeled` when the configured
 * trigger label was just applied. Anything else is not ours.
 */
export function issueTrigger(
  payload: Record<string, unknown>,
  input: { userName: string; triggerLabel?: string },
): IssueTrigger | null {
  const action = stringValue(payload.action);
  const issue = isRecord(payload.issue) ? payload.issue : null;
  if (!issue) return null;
  if (action === "assigned") {
    return isAssignedToBot(assigneeLogins(issue.assignees), input.userName)
      ? "assigned"
      : null;
  }
  if (action === "labeled" && input.triggerLabel) {
    const label = isRecord(payload.label) ? stringValue(payload.label.name) : undefined;
    return label && hasLabel([label], input.triggerLabel) ? "labeled" : null;
  }
  return null;
}

/**
 * Whether the account that handed the issue over may start issue work.
 *
 * Assigning or labelling someone else's issue needs triage access, which GitHub
 * enforces. But issue templates / issue forms apply their `labels:` and
 * `assignees:` on creation for *any* author, and those deliveries name the
 * author as the sender. So when the sender is the issue's own author, apply the
 * same author-association gate as the comment path (OWNER/MEMBER/COLLABORATOR
 * by default); otherwise someone with triage access made the hand-off. Fails
 * closed when the sender is missing.
 */
export function isIssueHandOffSenderAllowed(
  payload: Record<string, unknown>,
  options: Pick<GithubbotOptions, "allowedAuthorAssociations">,
): boolean {
  const sender = stringValue(isRecord(payload.sender) ? payload.sender.login : undefined);
  if (!sender) return false;
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const author = stringValue(isRecord(issue.user) ? issue.user.login : undefined);
  if (!author || author.toLowerCase() !== sender.toLowerCase()) return true;
  const allowed = resolveAllowedAuthorAssociations(options.allowedAuthorAssociations);
  if (allowed.includes("*")) return true;
  const association = stringValue(issue.author_association)?.toUpperCase();
  return !!association && allowed.includes(association);
}

/**
 * `issues` lifecycle: when the issue is handed to the bot — assigned to it, or
 * given the trigger label (a GitHub App can't be assigned) — run an autonomous
 * work turn.
 */
export function handleIssueEvent(
  ctx: IssueManagerContext,
  rawBody: string,
  deliveryId: string,
): Promise<void> | null {
  const payload = parseJson(rawBody);
  if (!payload) return null;
  const trigger = issueTrigger(payload, {
    userName: ctx.userName,
    triggerLabel: ctx.options.triggerLabel,
  });
  // Not a hand-off to us (a different assignee, another label, other actions).
  if (!trigger) return null;
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const repo = repoFromPayload(payload);
  if (!issue || !repo) return null;
  const number = numberValue(issue.number);
  if (number === undefined) return null;
  if (stringValue(issue.state) !== "open") return null;
  if (!isIssueHandOffSenderAllowed(payload, ctx.options)) {
    traceLog(ctx.options, "githubbot_issue_trigger_unauthorized_skipped", undefined, {
      issue: `${repo.owner}/${repo.repo}#${number}`,
      trigger,
      association: stringValue(issue.author_association) ?? "unknown",
    });
    return null;
  }

  const { options, state } = ctx;
  const title = stringValue(issue.title) ?? `#${number}`;
  const url =
    stringValue(issue.html_url) ??
    `https://github.com/${repo.owner}/${repo.repo}/issues/${number}`;
  const assigner =
    stringValue(isRecord(payload.sender) ? payload.sender.login : undefined) ??
    "a teammate";
  const threadKey = issueWorkThreadKey(repo.owner, repo.repo, number);
  const trace: GithubbotTrace = {
    includeContext: false,
    messageId: `issue-${threadKey}-${deliveryId}`,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId: threadKey,
  };

  return (async () => {
    const logger = options.logger ?? noopLogger;
    // Claim the delivery before the background run so a redelivery never
    // double-works. State-keyed (not Chat-thread-keyed) because the work thread
    // is synthetic and never touches the adapter.
    const dedupKey = `${options.stateKeyPrefix ?? "centaur-githubbot"}:issue-delivery:${threadKey}:${deliveryId}`;
    let claimed = true;
    try {
      claimed = await state.setIfNotExists(
        dedupKey,
        "1",
        ISSUE_WORK_DEDUP_TTL_MS,
      );
    } catch (error) {
      logger.debug("githubbot_issue_dedup_failed", {
        error: errorMessage(error),
      });
    }
    if (!claimed) {
      traceLog(options, "githubbot_issue_duplicate_skipped", trace, {
        delivery_id: deliveryId,
      });
      return;
    }
    // Assigning and labelling together (or the label landing with `gh issue
    // create --assignee --label`) arrives as two deliveries seconds apart; work
    // the issue once. A later re-assignment/re-label still re-triggers.
    let fresh = true;
    try {
      fresh = await state.setIfNotExists(
        `${options.stateKeyPrefix ?? "centaur-githubbot"}:issue-trigger:${threadKey}`,
        "1",
        ISSUE_TRIGGER_COALESCE_MS,
      );
    } catch {
      // best-effort; worst case both deliveries run
    }
    if (!fresh) {
      traceLog(options, "githubbot_issue_trigger_coalesced", trace, {
        delivery_id: deliveryId,
        trigger,
      });
      return;
    }
    traceLog(options, "githubbot_issue_assigned", trace, {
      assigner,
      issue: `${repo.owner}/${repo.repo}#${number}`,
      trigger,
    });
    // No triggering comment on an assignment, so ack on the issue itself —
    // instant 👀, settled to 🚀/😕 when the work turn finishes.
    await reactWorkingOnSubject(ctx.octokit, repo.owner, repo.repo, number, logger);

    let lastEventId = 0;
    const forwardInput: ForwardSessionInput = {
      afterEventId: 0,
      // The full issue-work methodology rides as the context preamble; a
      // deployment can fully replace it via options.issuePrompt.
      contextPreamble: options.issuePrompt ?? DEFAULT_ISSUE_PROMPT,
      conversationName: `${repo.owner}/${repo.repo}#${number}: ${title}`,
      executeMessage: issueTriggerMessage({
        assigner,
        deliveryId,
        number,
        owner: repo.owner,
        repo: repo.repo,
        threadKey,
        title,
        trigger,
        triggerLabel: options.triggerLabel,
        url,
      }),
      messages: [],
      model: undefined,
      onEventId: (eventId) => {
        lastEventId = Math.max(lastEventId, eventId);
        forwardInput.afterEventId = lastEventId;
      },
      openStream: false,
      threadId: threadKey,
      trace,
    };

    backgroundWaitUntil(
      runTurnStream(options, forwardInput)
        .then(async (result) => {
          traceLog(options, "githubbot_issue_turn_complete", trace, {
            chars: turnOutputChars(result),
            failed: result.failed,
          });
          await settleSubjectReaction(
            ctx.octokit,
            repo.owner,
            repo.repo,
            number,
            result.failed,
            logger,
          );
        })
        .catch(async (error) => {
          logger.warn("githubbot_issue_turn_failed", {
            error: errorMessage(error),
          });
          await settleSubjectReaction(
            ctx.octokit,
            repo.owner,
            repo.repo,
            number,
            true,
            logger,
          );
        }),
    );
  })();
}

/**
 * Whether an issue is the bot's work (assigned to it, or carrying the trigger
 * label), cached briefly so the conversational path doesn't hit the API on every
 * comment. Mirrors the PR manager's isPrOwned; a stale result only affects which
 * session a reply shares context with.
 */
export async function isIssueOwnedByBot(
  ctx: IssueManagerContext,
  owner: string,
  repo: string,
  number: number,
): Promise<boolean> {
  const cacheKey = `${ctx.options.stateKeyPrefix ?? "centaur-githubbot"}:issue-assigned-cache:${owner}/${repo}#${number}`;
  try {
    const cached = await ctx.state.get<string>(cacheKey);
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // fall through to a live lookup
  }
  let assigned = false;
  try {
    const { data } = await ctx.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: number,
    });
    assigned =
      isAssignedToBot(assigneeLogins(data.assignees), ctx.userName) ||
      hasLabel(labelNames(data.labels), ctx.options.triggerLabel);
  } catch (error) {
    (ctx.options.logger ?? noopLogger).debug(
      "githubbot_issue_assignment_lookup_failed",
      { error: errorMessage(error) },
    );
    return false;
  }
  try {
    await ctx.state.set(cacheKey, assigned ? "1" : "0", ASSIGNED_CACHE_TTL_MS);
  } catch {
    // best-effort cache
  }
  return assigned;
}

function issueTriggerMessage(input: {
  assigner: string;
  deliveryId: string;
  number: number;
  owner: string;
  repo: string;
  threadKey: string;
  title: string;
  trigger?: IssueTrigger;
  triggerLabel?: string;
  url: string;
}): GithubbotApiMessage {
  return {
    attachments: [],
    author: {
      fullName: "GitHub",
      isBot: false,
      isMe: false,
      userId: "github-issue",
      userName: "github-issue",
    },
    // Keyed by delivery id so a fresh assignment re-executes (the state claim
    // dedupes a redelivery of the same assignment).
    id: `issue-${input.threadKey}-${input.deliveryId}`,
    isMention: true,
    raw: { githubbotIssueWork: true, url: input.url },
    text: issueTriggerText(input),
    threadId: input.threadKey,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The issue-work turn's message. With a trigger label configured, PR ownership
 * runs through that label (the sandbox may push as a different account than the
 * bot, so "assign the PR to yourself" would not reach the bot), so the agent is
 * told to put the label on the PR it opens.
 */
export function issueTriggerText(input: {
  assigner: string;
  number: number;
  owner: string;
  repo: string;
  title: string;
  trigger?: IssueTrigger;
  triggerLabel?: string;
  url: string;
}): string {
  const handedOver =
    input.trigger === "labeled"
      ? `You have been handed GitHub issue ${input.owner}/${input.repo}#${input.number} — ` +
        `"${input.title}" (${input.url}) by @${input.assigner}, who added the ` +
        `"${input.triggerLabel ?? ""}" label.`
      : `You have been assigned GitHub issue ${input.owner}/${input.repo}#${input.number} — ` +
        `"${input.title}" (${input.url}) by @${input.assigner}.`;
  const labelLine = input.triggerLabel
    ? ` When you open the pull request, add the label "${input.triggerLabel}" to it ` +
      `(e.g. \`gh pr create --label ${shellQuote(input.triggerLabel)}\`): that label is ` +
      `how you keep managing the PR through CI and review.`
    : "";
  return (
    `${handedOver} Work it now, following your guidance above, using the gh CLI ` +
    `and git in your sandbox.${labelLine}`
  );
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Payload parsing helpers (kept local so the issue manager is self-contained).
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

export function isAssignedToBot(assignees: string[], userName: string): boolean {
  return assignees.some((login) => isBotLogin(login, userName));
}

export function assigneeLogins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const logins: string[] = [];
  for (const entry of value) {
    const login = isRecord(entry) ? stringValue(entry.login) : undefined;
    if (login) logins.push(login);
  }
  return logins;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJson(rawBody: string): JsonRecord | null {
  try {
    const value = JSON.parse(rawBody);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function repoFromPayload(
  payload: JsonRecord,
): { owner: string; repo: string } | null {
  const repository = payload.repository;
  if (!isRecord(repository)) return null;
  const fullName = stringValue(repository.full_name);
  if (!fullName) return null;
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) return null;
  return { owner, repo };
}
