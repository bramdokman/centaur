import { createAppAuth } from "@octokit/auth-app";
import type { GithubbotFetch } from "./types";

/**
 * GitHub App auth helpers. In App mode githubbot runs single-tenant: one fixed
 * installation, so the adapter's Octokit works outside a comment webhook (the
 * lifecycle handlers and the PR manager call it directly). The installation id
 * can be configured, or discovered at boot from the App's JWT.
 */

export type GithubAppCredentials = {
  appId: string;
  privateKey: string;
  installationId?: number;
};

/**
 * Accept a PEM as stored in env: real newlines, or `\n` escapes (common when a
 * key is pasted into a single-line secret). Surrounding whitespace is dropped.
 */
export function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replace(/\\n/g, "\n")
    : trimmed;
}

type InstallationSummary = {
  id: number;
  account: string | undefined;
};

/**
 * Pick the installation githubbot should act as.
 * - `repository` (`owner/repo`) set: the installation covering that repo.
 * - otherwise: the App's only installation; several is an error (be explicit).
 */
export async function discoverInstallationId(input: {
  appId: string;
  privateKey: string;
  apiUrl?: string;
  fetch?: GithubbotFetch;
  repository?: string;
}): Promise<number> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiUrl = (input.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const auth = createAppAuth({
    appId: input.appId,
    privateKey: input.privateKey,
  });
  const { token } = await auth({ type: "app" });
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "centaur-githubbot",
    "x-github-api-version": "2022-11-28",
  };

  if (input.repository) {
    const [owner, repo] = input.repository.split("/", 2);
    if (!owner || !repo) {
      throw new Error(
        `GITHUBBOT_APP_REPOSITORY must be owner/repo, got "${input.repository}"`,
      );
    }
    const response = await fetchImpl(
      `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub App ${input.appId} is not installed on ${input.repository} (HTTP ${response.status})`,
      );
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "number") {
      throw new Error("GitHub returned an installation without an id");
    }
    return body.id;
  }

  const response = await fetchImpl(`${apiUrl}/app/installations?per_page=100`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `Listing installations for GitHub App ${input.appId} failed (HTTP ${response.status})`,
    );
  }
  const list = (await response.json()) as unknown;
  const installations: InstallationSummary[] = Array.isArray(list)
    ? list.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as { id?: unknown; account?: { login?: unknown } };
        if (typeof record.id !== "number") return [];
        const account =
          typeof record.account?.login === "string"
            ? record.account.login
            : undefined;
        return [{ id: record.id, account }];
      })
    : [];
  if (installations.length === 0) {
    throw new Error(
      `GitHub App ${input.appId} has no installations; install it on the repo or org first`,
    );
  }
  if (installations.length > 1) {
    const accounts = installations
      .map((entry) => `${entry.account ?? "?"}=${entry.id}`)
      .join(", ");
    throw new Error(
      `GitHub App ${input.appId} has ${installations.length} installations (${accounts}); set GITHUBBOT_APP_INSTALLATION_ID or GITHUBBOT_APP_REPOSITORY`,
    );
  }
  return installations[0]!.id;
}
