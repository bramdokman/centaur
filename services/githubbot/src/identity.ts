/**
 * The bot's GitHub identity, normalized for both auth modes.
 *
 * - **PAT (machine user)**: the login is a plain user login (`centaur-bot`), and
 *   comments render `@centaur-bot`.
 * - **GitHub App**: the acting login is `<slug>[bot]`, but people (and GitHub's
 *   own autocomplete) mention it as `@<slug>`, without the suffix.
 *
 * `userName` may be configured either way; mention matching always uses the bare
 * name, and login comparisons accept both spellings.
 */

const BOT_SUFFIX = /\[bot\]$/i;

/** The name people type after `@` (the login without a `[bot]` suffix). */
export function botMentionName(userName: string): string {
  return userName.trim().replace(BOT_SUFFIX, "");
}

/**
 * Whether `login` is the bot itself: the bare name, or the App's `[bot]` login.
 * Case-insensitive (GitHub logins are).
 */
export function isBotLogin(
  login: string | null | undefined,
  userName: string,
): boolean {
  if (!login) return false;
  const bare = botMentionName(userName).toLowerCase();
  if (!bare) return false;
  const candidate = login.trim().toLowerCase();
  return candidate === bare || candidate === `${bare}[bot]`;
}
