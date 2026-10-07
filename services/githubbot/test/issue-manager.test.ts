import { describe, expect, test } from "bun:test";
import { drainBackgroundWork } from "../src/context";
import {
  assigneeLogins,
  handleIssueEvent,
  isAssignedToBot,
  isIssueHandOffSenderAllowed,
  isIssueOwnedByBot,
  issueTrigger,
  issueTriggerText,
  issueWorkThreadKey,
} from "../src/issue-manager";
import type { PrManagerContext } from "../src/pr-manager";

describe("isAssignedToBot", () => {
  test("true when the bot is among the assignees (case-insensitive)", () => {
    expect(isAssignedToBot(["someone", "Centaur-Bot"], "centaur-bot")).toBe(
      true,
    );
  });

  test("false when the bot is not an assignee", () => {
    expect(isAssignedToBot(["someone"], "centaur-bot")).toBe(false);
  });

  test("false with no assignees", () => {
    expect(isAssignedToBot([], "centaur-bot")).toBe(false);
  });

  test("matches an App's [bot] login against its bare slug", () => {
    expect(isAssignedToBot(["my-app[bot]"], "my-app")).toBe(true);
  });
});

describe("assigneeLogins", () => {
  test("extracts logins, skipping malformed entries", () => {
    expect(
      assigneeLogins([
        { login: "alice" },
        null,
        {},
        { login: "" },
        { login: "bob" },
      ]),
    ).toEqual(["alice", "bob"]);
  });

  test("returns [] for non-array input", () => {
    expect(assigneeLogins(undefined)).toEqual([]);
    expect(assigneeLogins(null)).toEqual([]);
    expect(assigneeLogins("nope")).toEqual([]);
  });
});

describe("issueWorkThreadKey", () => {
  test("builds the isolated work-session key", () => {
    expect(issueWorkThreadKey("0xSplits", "centaur", 7)).toBe(
      "github-issue:0xSplits/centaur:7",
    );
  });
});

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLogger;
  },
};

function issueCtx(input: {
  triggerLabel?: string;
  issue?: { assignees?: { login: string }[]; labels?: { name: string }[] };
}) {
  const values = new Map<string, unknown>();
  const executes: string[] = [];
  const reactions: string[] = [];
  const ctx = {
    octokit: {
      rest: {
        reactions: {
          createForIssue: async (req: { content: string }) => {
            reactions.push(req.content);
            return { data: { id: 1 } };
          },
        },
        issues: {
          get: async () => ({
            data: {
              assignees: input.issue?.assignees ?? [],
              labels: input.issue?.labels ?? [],
            },
          }),
        },
      },
    },
    options: {
      apiUrl: "http://127.0.0.1:8080",
      logger: quietLogger,
      stateKeyPrefix: "test",
      triggerLabel: input.triggerLabel,
      // Record execute bodies; non-retryable so the turn settles off the network.
      // Session create succeeds; execute is recorded and refused (non-retryable).
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/execute")) {
          executes.push(String(init?.body ?? ""));
          return new Response("no", { status: 400 });
        }
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    state: {
      get: async (k: string) => values.get(k),
      set: async (k: string, v: unknown) => {
        values.set(k, v);
      },
      setIfNotExists: async (k: string, v: unknown) => {
        if (values.has(k)) return false;
        values.set(k, v);
        return true;
      },
    },
    userName: "my-app",
  } as unknown as PrManagerContext;
  return { ctx, executes, reactions };
}

function issuesEvent(input: {
  action: string;
  label?: string;
  assignees?: string[];
  state?: string;
  author?: string;
  association?: string;
  sender?: string;
}) {
  return JSON.stringify({
    action: input.action,
    repository: { full_name: "acme/widgets" },
    issue: {
      number: 3,
      state: input.state ?? "open",
      title: "Fix it",
      html_url: "https://github.com/acme/widgets/issues/3",
      assignees: (input.assignees ?? []).map((login) => ({ login })),
      user: { login: input.author ?? "reporter" },
      author_association: input.association ?? "NONE",
    },
    ...(input.label ? { label: { name: input.label } } : {}),
    sender: { login: input.sender ?? "maintainer" },
  });
}

describe("issueTrigger", () => {
  const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

  test("assignment to the bot", () => {
    expect(
      issueTrigger(parse(issuesEvent({ action: "assigned", assignees: ["my-app"] })), {
        userName: "my-app",
      }),
    ).toBe("assigned");
    expect(
      issueTrigger(parse(issuesEvent({ action: "assigned", assignees: ["other"] })), {
        userName: "my-app",
      }),
    ).toBeNull();
  });

  test("the trigger label, only when configured (case-insensitive)", () => {
    const labeled = parse(issuesEvent({ action: "labeled", label: "Centaur" }));
    expect(issueTrigger(labeled, { userName: "my-app", triggerLabel: "centaur" })).toBe(
      "labeled",
    );
    expect(issueTrigger(labeled, { userName: "my-app" })).toBeNull();
    expect(
      issueTrigger(parse(issuesEvent({ action: "labeled", label: "bug" })), {
        userName: "my-app",
        triggerLabel: "centaur",
      }),
    ).toBeNull();
  });

  test("other actions are ignored", () => {
    expect(
      issueTrigger(parse(issuesEvent({ action: "unlabeled", label: "centaur" })), {
        userName: "my-app",
        triggerLabel: "centaur",
      }),
    ).toBeNull();
  });
});

describe("issueTriggerText", () => {
  const base = {
    assigner: "maintainer",
    number: 3,
    owner: "acme",
    repo: "widgets",
    title: "Fix it",
    url: "https://github.com/acme/widgets/issues/3",
  };

  test("tells the agent to label its PR when a trigger label is configured", () => {
    const text = issueTriggerText({ ...base, trigger: "labeled", triggerLabel: "centaur" });
    expect(text).toContain('added the "centaur" label');
    expect(text).toContain("gh pr create --label centaur");
  });

  test("quotes an unusual label for the shell", () => {
    expect(
      issueTriggerText({ ...base, trigger: "labeled", triggerLabel: "agent work" }),
    ).toContain("--label 'agent work'");
  });

  test("assignment wording without a label is unchanged", () => {
    const text = issueTriggerText({ ...base, trigger: "assigned" });
    expect(text).toContain("You have been assigned GitHub issue acme/widgets#3");
    expect(text).not.toContain("--label");
  });
});

describe("handleIssueEvent", () => {
  test("the trigger label starts issue work", async () => {
    const { ctx, executes, reactions } = issueCtx({ triggerLabel: "centaur" });
    const work = handleIssueEvent(
      ctx,
      issuesEvent({ action: "labeled", label: "centaur" }),
      "d1",
    );
    expect(work).not.toBeNull();
    await work;
    await drainBackgroundWork(2_000);
    expect(reactions[0]).toBe("eyes");
    expect(executes.length).toBeGreaterThan(0);
    expect(executes[0]).toContain("gh pr create --label centaur");
  });

  test("a label is not a trigger when the label trigger is off", () => {
    const { ctx } = issueCtx({});
    expect(
      handleIssueEvent(ctx, issuesEvent({ action: "labeled", label: "centaur" }), "d1"),
    ).toBeNull();
  });

  test("closed issues are ignored", () => {
    const { ctx } = issueCtx({ triggerLabel: "centaur" });
    expect(
      handleIssueEvent(
        ctx,
        issuesEvent({ action: "labeled", label: "centaur", state: "closed" }),
        "d1",
      ),
    ).toBeNull();
  });

  test("assignment + label together work the issue once", async () => {
    const { ctx, reactions } = issueCtx({ triggerLabel: "centaur" });
    await handleIssueEvent(
      ctx,
      issuesEvent({ action: "assigned", assignees: ["my-app"] }),
      "d1",
    );
    await handleIssueEvent(
      ctx,
      issuesEvent({ action: "labeled", label: "centaur" }),
      "d2",
    );
    await drainBackgroundWork(2_000);
    // One 👀 ack (plus its settle), not two.
    expect(reactions.filter((r) => r === "eyes").length).toBe(1);
  });
});

describe("isIssueOwnedByBot", () => {
  test("owned through the trigger label", async () => {
    const { ctx } = issueCtx({
      triggerLabel: "centaur",
      issue: { labels: [{ name: "centaur" }] },
    });
    expect(await isIssueOwnedByBot(ctx, "acme", "widgets", 3)).toBe(true);
  });

  test("owned through assignment to the [bot] login", async () => {
    const { ctx } = issueCtx({ issue: { assignees: [{ login: "my-app[bot]" }] } });
    expect(await isIssueOwnedByBot(ctx, "acme", "widgets", 3)).toBe(true);
  });

  test("not owned otherwise", async () => {
    const { ctx } = issueCtx({ issue: { labels: [{ name: "centaur" }] } });
    expect(await isIssueOwnedByBot(ctx, "acme", "widgets", 3)).toBe(false);
  });
});

describe("isIssueHandOffSenderAllowed", () => {
  const parse = (body: string) => JSON.parse(body) as Record<string, unknown>;

  /** A ctx whose permission lookup answers `roles[login]` (else 404). */
  function permCtx(
    roles: Record<string, string>,
    options: Record<string, unknown> = {},
  ) {
    const lookups: string[] = [];
    const ctx = {
      octokit: {
        rest: {
          repos: {
            getCollaboratorPermissionLevel: async (req: {
              owner: string;
              repo: string;
              username: string;
            }) => {
              lookups.push(`${req.owner}/${req.repo}:${req.username}`);
              const role = roles[req.username];
              if (!role) throw Object.assign(new Error("Not Found"), { status: 404 });
              return {
                data: {
                  permission: role === "triage" ? "read" : role,
                  role_name: role,
                  user: { login: req.username },
                },
              };
            },
          },
        },
      },
      options,
    } as unknown as Pick<PrManagerContext, "octokit" | "options">;
    return { ctx, lookups };
  }

  test("a triager labelling someone else's issue is allowed", async () => {
    const { ctx, lookups } = permCtx({});
    expect(
      await isIssueHandOffSenderAllowed(
        parse(issuesEvent({ action: "labeled", label: "centaur", author: "outsider" })),
        ctx,
      ),
    ).toBe(true);
    expect(lookups).toEqual([]);
  });

  test("an untrusted author whose issue template applied the label is refused", async () => {
    const body = parse(
      issuesEvent({
        action: "labeled",
        label: "centaur",
        author: "outsider",
        sender: "Outsider",
        association: "NONE",
      }),
    );
    // No repo access at all (404) and read-only access are both refused.
    expect(await isIssueHandOffSenderAllowed(body, permCtx({}).ctx)).toBe(false);
    expect(
      await isIssueHandOffSenderAllowed(body, permCtx({ Outsider: "read" }).ctx),
    ).toBe(false);
    expect(
      await isIssueHandOffSenderAllowed(
        body,
        permCtx({}, { allowedAuthorAssociations: ["*"] }).ctx,
      ),
    ).toBe(true);
  });

  test("a trusted author labelling their own issue is allowed without a lookup", async () => {
    const { ctx, lookups } = permCtx({});
    expect(
      await isIssueHandOffSenderAllowed(
        parse(
          issuesEvent({
            action: "labeled",
            label: "centaur",
            author: "owner",
            sender: "owner",
            association: "OWNER",
          }),
        ),
        ctx,
      ),
    ).toBe(true);
    expect(lookups).toEqual([]);
  });

  test("a private org member stamped CONTRIBUTOR is allowed by repo permission (cached)", async () => {
    const { ctx, lookups } = permCtx({ orgadmin: "admin" });
    const body = parse(
      issuesEvent({
        action: "labeled",
        label: "centaur",
        author: "orgadmin",
        sender: "orgadmin",
        association: "CONTRIBUTOR",
      }),
    );
    expect(await isIssueHandOffSenderAllowed(body, ctx)).toBe(true);
    expect(await isIssueHandOffSenderAllowed(body, ctx)).toBe(true);
    expect(lookups).toEqual(["acme/widgets:orgadmin"]);
  });

  test("triage, write and maintain roles count; a failed lookup denies", async () => {
    for (const role of ["triage", "write", "maintain"]) {
      const body = parse(
        issuesEvent({
          action: "labeled",
          label: "centaur",
          author: "dev",
          sender: "dev",
          association: "CONTRIBUTOR",
        }),
      );
      expect(await isIssueHandOffSenderAllowed(body, permCtx({ dev: role }).ctx)).toBe(true);
    }
    const noLookup = { octokit: { rest: { repos: {} } }, options: {} } as unknown as Pick<
      PrManagerContext,
      "octokit" | "options"
    >;
    expect(
      await isIssueHandOffSenderAllowed(
        parse(
          issuesEvent({
            action: "labeled",
            label: "centaur",
            author: "dev",
            sender: "dev",
            association: "CONTRIBUTOR",
          }),
        ),
        noLookup,
      ),
    ).toBe(false);
  });

  test("handleIssueEvent skips a template-applied label from an untrusted author", async () => {
    const { ctx, executes, reactions } = issueCtx({ triggerLabel: "centaur" });
    await handleIssueEvent(
      ctx,
      issuesEvent({
        action: "labeled",
        label: "centaur",
        author: "outsider",
        sender: "outsider",
        association: "FIRST_TIME_CONTRIBUTOR",
      }),
      "d1",
    );
    await drainBackgroundWork(2_000);
    expect(reactions).toEqual([]);
    expect(executes).toEqual([]);
  });

  test("handleIssueEvent works a self-labelled issue of a CONTRIBUTOR-stamped admin", async () => {
    const { ctx, executes, reactions } = issueCtx({ triggerLabel: "centaur" });
    (ctx.octokit.rest as unknown as { repos: unknown }).repos = {
      getCollaboratorPermissionLevel: async () => ({
        data: { permission: "admin", role_name: "admin" },
      }),
    };
    await handleIssueEvent(
      ctx,
      issuesEvent({
        action: "labeled",
        label: "centaur",
        author: "orgadmin",
        sender: "orgadmin",
        association: "CONTRIBUTOR",
      }),
      "d1",
    );
    await drainBackgroundWork(2_000);
    expect(reactions[0]).toBe("eyes");
    expect(executes.length).toBeGreaterThan(0);
  });
});
