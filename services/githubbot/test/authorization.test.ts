import { describe, expect, test } from "bun:test";
import {
  authorAssociationFromRaw,
  DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS,
  isActorAllowed,
  isCommentAuthorAllowed,
  permissionGrantsTriage,
  resolveAllowedAuthorAssociations,
} from "../src/authorization";

function raw(association: unknown): unknown {
  return {
    type: "issue_comment",
    comment: { author_association: association },
  };
}

describe("authorAssociationFromRaw", () => {
  test("reads author_association from the raw comment", () => {
    expect(authorAssociationFromRaw(raw("MEMBER"))).toBe("MEMBER");
  });

  test("undefined for a non-comment / malformed shape", () => {
    expect(authorAssociationFromRaw({ type: "x" })).toBeUndefined();
    expect(authorAssociationFromRaw({ comment: {} })).toBeUndefined();
    expect(authorAssociationFromRaw(null)).toBeUndefined();
    expect(authorAssociationFromRaw("nope")).toBeUndefined();
  });
});

describe("resolveAllowedAuthorAssociations", () => {
  test("defaults when unset, empty, or blank", () => {
    const want = [...DEFAULT_ALLOWED_AUTHOR_ASSOCIATIONS];
    expect(resolveAllowedAuthorAssociations(undefined)).toEqual(want);
    expect(resolveAllowedAuthorAssociations([])).toEqual(want);
    expect(resolveAllowedAuthorAssociations(["  "])).toEqual(want);
  });

  test("uppercases and trims configured values", () => {
    expect(resolveAllowedAuthorAssociations([" owner ", "Member"])).toEqual([
      "OWNER",
      "MEMBER",
    ]);
  });
});

describe("isCommentAuthorAllowed", () => {
  test("allows the default collaborator-and-up set", () => {
    for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(isCommentAuthorAllowed(raw(assoc), {})).toBe(true);
    }
  });

  test("denies contributors and outsiders by default", () => {
    for (const assoc of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
      expect(isCommentAuthorAllowed(raw(assoc), {})).toBe(false);
    }
  });

  test("matches case-insensitively", () => {
    expect(isCommentAuthorAllowed(raw("member"), {})).toBe(true);
  });

  test("fails closed when the association can't be read", () => {
    expect(isCommentAuthorAllowed({ comment: {} }, {})).toBe(false);
    expect(isCommentAuthorAllowed(null, {})).toBe(false);
  });

  test("the '*' sentinel allows everyone (incl. unreadable)", () => {
    const opts = { allowedAuthorAssociations: ["*"] };
    expect(isCommentAuthorAllowed(raw("NONE"), opts)).toBe(true);
    expect(isCommentAuthorAllowed(null, opts)).toBe(true);
  });

  test("honors a custom allowlist", () => {
    const opts = { allowedAuthorAssociations: ["contributor"] };
    expect(isCommentAuthorAllowed(raw("CONTRIBUTOR"), opts)).toBe(true);
    expect(isCommentAuthorAllowed(raw("MEMBER"), opts)).toBe(false);
  });
});

describe("permissionGrantsTriage", () => {
  test("triage and up, by role name, permission map, or legacy level", () => {
    for (const role of ["triage", "write", "maintain", "admin"]) {
      expect(permissionGrantsTriage({ role_name: role })).toBe(true);
    }
    expect(permissionGrantsTriage({ role_name: "custom", user: { permissions: { triage: true } } })).toBe(true);
    expect(permissionGrantsTriage({ permission: "write" })).toBe(true);
    expect(permissionGrantsTriage({ permission: "read", role_name: "read" })).toBe(false);
    expect(permissionGrantsTriage({ permission: "none", role_name: "none" })).toBe(false);
    expect(permissionGrantsTriage(null)).toBe(false);
  });
});

describe("isActorAllowed", () => {
  function ctx(role: string | Error, options: Record<string, unknown> = {}) {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        octokit: {
          rest: {
            repos: {
              getCollaboratorPermissionLevel: async (req: { username: string }) => {
                calls.push(req.username);
                if (role instanceof Error) throw role;
                return { data: { role_name: role } };
              },
            },
          },
        },
        options,
      },
    };
  }
  const who = { login: "dev", owner: "o", repo: "r" };

  test("an allowed association needs no lookup", async () => {
    const { ctx: c, calls } = ctx("read");
    expect(await isActorAllowed({ ...who, association: "member" }, c)).toBe(true);
    expect(calls).toEqual([]);
  });

  test("falls back to repo permission for CONTRIBUTOR/NONE", async () => {
    expect(await isActorAllowed({ ...who, association: "CONTRIBUTOR" }, ctx("admin").ctx)).toBe(true);
    expect(await isActorAllowed({ ...who, association: "NONE" }, ctx("triage").ctx)).toBe(true);
    expect(await isActorAllowed({ ...who, association: "CONTRIBUTOR" }, ctx("read").ctx)).toBe(false);
  });

  test("fails closed on a lookup error or missing login/repo, without caching errors", async () => {
    const { ctx: c, calls } = ctx(new Error("boom"));
    expect(await isActorAllowed({ ...who, association: "CONTRIBUTOR" }, c)).toBe(false);
    expect(await isActorAllowed({ ...who, association: "CONTRIBUTOR" }, c)).toBe(false);
    expect(calls.length).toBe(2);
    const ok = ctx("admin");
    expect(await isActorAllowed({ ...who, login: undefined, association: "NONE" }, ok.ctx)).toBe(false);
    expect(await isActorAllowed({ ...who, owner: undefined, association: "NONE" }, ok.ctx)).toBe(false);
    expect(ok.calls).toEqual([]);
  });

  test("caches the answer per login and repo", async () => {
    const { ctx: c, calls } = ctx("write");
    await isActorAllowed({ ...who, association: "CONTRIBUTOR" }, c);
    await isActorAllowed({ ...who, login: "DEV", association: "CONTRIBUTOR" }, c);
    await isActorAllowed({ ...who, repo: "other", association: "CONTRIBUTOR" }, c);
    expect(calls).toEqual(["dev", "dev"]);
  });

  test("'*' allows everyone without a lookup", async () => {
    const { ctx: c, calls } = ctx("read", { allowedAuthorAssociations: ["*"] });
    expect(await isActorAllowed({ ...who, association: "NONE" }, c)).toBe(true);
    expect(calls).toEqual([]);
  });
});
