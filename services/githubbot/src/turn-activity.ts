/**
 * In-process record of when agent turns run against a pull request, so the PR
 * manager can tell an agent's own GitHub activity (posted as an agent login,
 * e.g. the sandbox PAT's user) from a human's. Kept in memory: githubbot runs as
 * one replica, every turn goes through runTurnStream in this process, and a
 * restart ends the turns it would have tracked anyway.
 */

// Per PR: the start of every turn still running, and the [start, end] of the
// most recent finished turns. Intervals (not just "last start/end") so a review
// is attributed to the turn that was actually running when it was submitted.
type Interval = { endMs: number; startMs: number };
type Activity = { recent: Interval[]; running: Set<{ startMs: number }> };
const MAX_RECENT_PER_PR = 20;

const activity = new Map<string, Activity>();
const MAX_ENTRIES = 2_000;

// Session keys whose turns act on a pull request: the PR conversation thread
// (`github:{o}/{r}:{n}` and its review-comment form), the management session
// (`github-manage:…`) and the review session (`github-review:…`).
const PR_SESSION_KEY =
  /^(?:github|github-manage|github-review):([^/:]+)\/([^:]+):(\d+)(?::rc:\d+)?$/;

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`.toLowerCase();
}

/** The PR a session key's turns act on, or null (issues, other platforms). */
export function prFromSessionKey(
  key: string,
): { owner: string; repo: string; number: number } | null {
  const match = PR_SESSION_KEY.exec(key);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isFinite(number)) return null;
  return { owner: match[1]!, repo: match[2]!, number };
}

/** Mark a turn on `sessionKey` as started; returns the matching end callback. */
export function markTurnStarted(
  sessionKey: string,
  nowMs = Date.now(),
): (endMs?: number) => void {
  const pr = prFromSessionKey(sessionKey);
  if (!pr) return () => undefined;
  const key = prKey(pr.owner, pr.repo, pr.number);
  const entry = activity.get(key) ?? { recent: [], running: new Set() };
  const turn = { startMs: nowMs };
  entry.running.add(turn);
  activity.delete(key); // re-insert so the map stays in recency order
  activity.set(key, entry);
  if (activity.size > MAX_ENTRIES) {
    for (const [k, v] of activity) {
      if (activity.size <= MAX_ENTRIES) break;
      if (v.running.size === 0) activity.delete(k);
    }
  }
  let ended = false;
  return (endMs = Date.now()) => {
    if (ended) return;
    ended = true;
    entry.running.delete(turn);
    entry.recent.push({ startMs: turn.startMs, endMs: Math.max(endMs, turn.startMs) });
    if (entry.recent.length > MAX_RECENT_PER_PR) entry.recent.shift();
  };
}

/**
 * Whether an agent turn on this PR was running at `atMs`, or ended no more than
 * `graceMs` before it (the review webhook can trail the agent's API call, and
 * the turn's stream can close just before GitHub stamps the review).
 */
export function wasPrTurnActive(
  owner: string,
  repo: string,
  number: number,
  atMs: number,
  graceMs: number,
): boolean {
  const entry = activity.get(prKey(owner, repo, number));
  if (!entry) return false;
  // A small lead-in grace covers clock skew between GitHub and this process.
  for (const turn of entry.running) {
    if (atMs >= turn.startMs - graceMs) return true;
  }
  return entry.recent.some(
    (turn) => atMs >= turn.startMs - graceMs && atMs <= turn.endMs + graceMs,
  );
}

/** Test hook. */
export function resetTurnActivity(): void {
  activity.clear();
}
