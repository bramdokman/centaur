import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { drainBackgroundWork } from "../src/context";
import { createGithubbot } from "../src/index";

// End-to-end through createGithubbot in GitHub App mode: a local stub stands in
// for api.github.com (installation token + reactions), and a recording fetch
// stands in for api-rs. Nothing leaves the process.

const BOT_ID = 90001;
const SECRET = "test-webhook-secret";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const githubCalls: string[] = [];
let githubStub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  githubStub = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      githubCalls.push(`${request.method} ${path}`);
      if (path === "/app/installations/2/access_tokens") {
        return Response.json(
          {
            token: "ghs_stub",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          },
          { status: 201 },
        );
      }
      return Response.json({ id: 1 }, { status: 201 });
    },
  });
});

afterAll(() => {
  githubStub.stop(true);
});

// `null` = leave the bot id unset (auto-detection).
function makeBot(botUserId: string | null = String(BOT_ID)) {
  const apiCalls: string[] = [];
  const bot = createGithubbot({
    apiUrl: "http://api-rs.invalid",
    app: { appId: "1234", installationId: 2, privateKey },
    botUserId: botUserId ?? undefined,
    connectStateOnStart: false,
    // Session create/execute refused (non-retryable) — we only need to see that a
    // turn was (or was not) started.
    fetch: async (url) => {
      apiCalls.push(String(url));
      return new Response("no", { status: 400 });
    },
    githubApiUrl: githubStub.url.toString().replace(/\/$/, ""),
    state: createMemoryState(),
    userName: "my-app[bot]",
    webhookSecret: SECRET,
  });
  return { apiCalls, bot };
}

// The adapter dispatches comment handlers after the webhook returns, so poll.
async function settle(until: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await drainBackgroundWork(5_000);
}

function commentWebhook(input: {
  body: string;
  login: string;
  userId: number;
  type?: string;
  commentId: number;
}): Request {
  const payload = JSON.stringify({
    action: "created",
    comment: {
      id: input.commentId,
      body: input.body,
      user: { id: input.userId, login: input.login, type: input.type ?? "User" },
      // Allowed association even for the bot, so only the loop guard can stop it.
      author_association: "OWNER",
      created_at: "2026-10-07T10:00:00Z",
      updated_at: "2026-10-07T10:00:00Z",
      html_url: "https://github.com/acme/widgets/issues/3#issuecomment-1",
    },
    issue: { number: 3, title: "Fix it" },
    repository: {
      name: "widgets",
      full_name: "acme/widgets",
      owner: { login: "acme" },
    },
    sender: { id: input.userId, login: input.login, type: input.type ?? "User" },
    installation: { id: 2 },
  });
  const signature = `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
  return new Request("http://githubbot/api/webhooks/github", {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": `delivery-${input.commentId}`,
      "x-hub-signature-256": signature,
    },
  });
}

describe("GitHub App mode", () => {
  test("a teammate's @<slug> mention runs a turn, acked as the App installation", async () => {
    const { apiCalls, bot } = makeBot();
    const response = await bot.app.fetch(
      commentWebhook({
        body: "@my-app please take a look",
        login: "maintainer",
        userId: 1001,
        commentId: 11,
      }),
    );
    expect(response.status).toBe(200);
    await settle(() => apiCalls.length > 0);
    expect(apiCalls.some((url) => url.includes("/api/session/"))).toBe(true);
    // The 👀 ack went through an installation token, not a PAT.
    expect(githubCalls).toContain("POST /app/installations/2/access_tokens");
    expect(githubCalls.some((call) => call.includes("/reactions"))).toBe(true);
  });

  test("the App's own comment mentioning itself is dropped by the loop guard", async () => {
    const { apiCalls, bot } = makeBot();
    await bot.app.fetch(
      commentWebhook({
        body: "Done — ping @my-app again if needed",
        login: "my-app[bot]",
        userId: BOT_ID,
        type: "Bot",
        commentId: 12,
      }),
    );
    await settle(() => apiCalls.length > 0, 500);
    expect(apiCalls).toEqual([]);
  });

  test("the [bot] login guard holds even when the numeric bot id is wrong", async () => {
    // The stub answers the id auto-detection with id 1, so the adapter's own
    // sender-id check misses the App's comment; the login check must catch it.
    const { apiCalls, bot } = makeBot(null);
    await bot.app.fetch(
      commentWebhook({
        body: "@my-app looping?",
        login: "my-app[bot]",
        userId: BOT_ID,
        type: "Bot",
        commentId: 13,
      }),
    );
    await settle(() => apiCalls.length > 0, 500);
    expect(apiCalls).toEqual([]);
  });
});
