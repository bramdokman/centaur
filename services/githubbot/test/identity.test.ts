import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { discoverInstallationId, normalizePrivateKey } from "../src/app-auth";
import {
  botMentionName,
  hasLabel,
  isBotLogin,
  isOwnActorLogin,
  labelNames,
} from "../src/identity";
import { githubAuthConfig } from "../src/index";

describe("botMentionName", () => {
  test("strips an App's [bot] suffix", () => {
    expect(botMentionName("my-app[bot]")).toBe(
      "my-app",
    );
    expect(botMentionName("My-App[BOT]")).toBe("My-App");
  });

  test("leaves a user login alone", () => {
    expect(botMentionName("centaur-bot")).toBe("centaur-bot");
  });
});

describe("isBotLogin", () => {
  test("matches the App's [bot] login from a bare slug, and vice versa", () => {
    expect(isBotLogin("my-app[bot]", "my-app")).toBe(
      true,
    );
    expect(isBotLogin("my-app", "my-app[bot]")).toBe(
      true,
    );
    expect(isBotLogin("Centaur-Bot", "centaur-bot")).toBe(true);
  });

  test("does not match other logins or prefixes", () => {
    expect(isBotLogin("my-app-x", "my-app")).toBe(
      false,
    );
    expect(isBotLogin("github-actions[bot]", "my-app")).toBe(false);
    expect(isBotLogin("octocat", "my-app")).toBe(false);
    expect(isBotLogin(undefined, "centaur-bot")).toBe(false);
    expect(isBotLogin("", "centaur-bot")).toBe(false);
    expect(isBotLogin("[bot]", "")).toBe(false);
  });
});

describe("isOwnActorLogin", () => {
  test("counts the bot and the configured agent logins", () => {
    expect(isOwnActorLogin("my-app[bot]", "my-app", undefined)).toBe(true);
    expect(isOwnActorLogin("Octocat", "my-app", ["octocat"])).toBe(true);
    expect(isOwnActorLogin("someone", "my-app", ["octocat"])).toBe(false);
    expect(isOwnActorLogin(undefined, "my-app", ["octocat"])).toBe(false);
  });
});

describe("labels", () => {
  test("hasLabel is case-insensitive and off when unset", () => {
    expect(hasLabel(["bug", "Centaur"], "centaur")).toBe(true);
    expect(hasLabel(["bug"], "centaur")).toBe(false);
    expect(hasLabel(["centaur"], undefined)).toBe(false);
    expect(hasLabel(["centaur"], "  ")).toBe(false);
  });

  test("labelNames reads strings and {name} objects", () => {
    expect(labelNames(["a", { name: "b" }, { color: "x" }, null, ""])).toEqual([
      "a",
      "b",
    ]);
    expect(labelNames(undefined)).toEqual([]);
  });
});

describe("githubAuthConfig", () => {
  test("PAT mode", () => {
    expect(githubAuthConfig({ token: "t" })).toEqual({ token: "t" });
  });

  test("App mode pins the installation", () => {
    expect(
      githubAuthConfig({
        app: { appId: "1", installationId: 2, privateKey: "k" },
      }),
    ).toEqual({ appId: "1", installationId: 2, privateKey: "k" });
  });

  test("rejects both or neither", () => {
    expect(() =>
      githubAuthConfig({
        token: "t",
        app: { appId: "1", installationId: 2, privateKey: "k" },
      }),
    ).toThrow();
    expect(() => githubAuthConfig({})).toThrow();
  });
});

describe("normalizePrivateKey", () => {
  test("expands \\n escapes in a single-line key", () => {
    expect(normalizePrivateKey("-----BEGIN X-----\\nabc\\n-----END X-----\n")).toBe(
      "-----BEGIN X-----\nabc\n-----END X-----",
    );
  });

  test("keeps a multi-line key as-is (trimmed)", () => {
    const pem = "-----BEGIN X-----\nabc\n-----END X-----";
    expect(normalizePrivateKey(`${pem}\n`)).toBe(pem);
  });
});

describe("discoverInstallationId", () => {
  // A throwaway key: the JWT is signed locally and only seen by the stub fetch.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
    const calls: { url: string; auth: string | null }[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      const path = new URL(url).pathname;
      const route = routes[path];
      if (!route) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(route.body), { status: route.status });
    };
    return { calls, fetch };
  }

  test("uses the App's only installation, authenticating with a JWT", async () => {
    const { calls, fetch } = stubFetch({
      "/app/installations": {
        status: 200,
        body: [{ id: 42001, account: { login: "acme" } }],
      },
    });
    await expect(
      discoverInstallationId({ appId: "1234", privateKey, fetch }),
    ).resolves.toBe(42001);
    expect(calls[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("resolves the installation for a named repository", async () => {
    const { calls, fetch } = stubFetch({
      "/api/v3/repos/acme/widgets/installation": { status: 200, body: { id: 42 } },
    });
    await expect(
      discoverInstallationId({
        appId: "1",
        privateKey,
        fetch,
        repository: "acme/widgets",
        apiUrl: "https://ghe.example.com/api/v3/",
      }),
    ).resolves.toBe(42);
    expect(calls[0]?.url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/widgets/installation",
    );
  });

  test("refuses to guess between several installations", async () => {
    const { fetch } = stubFetch({
      "/app/installations": {
        status: 200,
        body: [
          { id: 1, account: { login: "a" } },
          { id: 2, account: { login: "b" } },
        ],
      },
    });
    await expect(
      discoverInstallationId({ appId: "1", privateKey, fetch }),
    ).rejects.toThrow(/GITHUBBOT_APP_INSTALLATION_ID/);
  });

  test("fails when the App is not installed", async () => {
    const { fetch } = stubFetch({
      "/app/installations": { status: 200, body: [] },
    });
    await expect(
      discoverInstallationId({ appId: "1", privateKey, fetch }),
    ).rejects.toThrow(/no installations/);
    await expect(
      discoverInstallationId({ appId: "1", privateKey, fetch, repository: "a/b" }),
    ).rejects.toThrow(/not installed on a\/b/);
  });
});
