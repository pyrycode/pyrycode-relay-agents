// Integration tests for the dispatcher's six extracted phase functions
// plus the orchestrator wiring. The pure-function decompositions in
// `lib.test.ts` cover the decisions; this file covers the IO-bearing
// glue around them — error labels on push failure, empty-branch guard,
// salvage routing, branch setup matrix, worktree cleanup invariants.
//
// Architecture: `DispatchDeps` (in dispatch.ts) lets tests swap every
// fs/child_process/helper call. `makeMockDeps` returns a deps object
// plus a `calls` log for assertions. `MockGitHubClient` mirrors the
// `MockClient` pattern from `reconcile.test.ts`, extended for the
// `addLabel` / `removeLabel` / `addComment` / `getIssueLabels` /
// `getItemStatus` surface dispatch.ts uses.
//
// **Why DI vs `mock.module()`:** the deps shape is small (10 fields),
// production wiring stays close to today (one destructure line per
// phase), and tests can construct exactly the failure mode they want
// (push-fail, gh-list-fail, merge-conflict) by swapping individual
// handlers — much cheaper than module-level mocks under tsx's loader.
//
// Coverage scope follows the plan in this session's PR — Tier B
// (known production failure modes + happy paths + decision branches).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  makeDispatchContext,
  setupBranchAndWorktree,
  type DispatchClient,
  type DispatchContext,
  type DispatchDeps,
  type StreamResult,
} from "./dispatch.js";
import type { AgentConfig, BlockerInfo, ProjectItem } from "./types.js";

// --------- Call log (assertion surface) ---------

/**
 * Every IO call the phase functions made during one test. Tests assert
 * shape against this — "did execSync receive `git push`?", "how many
 * times was addLabel called?", etc. Recording is structural; tests
 * decide whether to assert on order, count, or contents.
 */
export type CallLog = {
  exec: { cmd: string; opts?: any }[];
  spawn: { cmd: string; args: string[]; opts?: any; input?: string }[];
  fs: { kind: "exists" | "read" | "write" | "mkdir" | "symlink"; path: string; content?: string; target?: string }[];
  client: { method: string; args: any[] }[];
  discord: string[];
  /** Count of `runClaudeStreaming` invocations (not the streamed output). */
  claudeStreams: number;
};

function emptyCallLog(): CallLog {
  return {
    exec: [],
    spawn: [],
    fs: [],
    client: [],
    discord: [],
    claudeStreams: 0,
  };
}

// --------- Mock deps ---------

/**
 * Per-pattern handler for `execSync` — pattern is matched as a substring
 * of the command. Return string (success) or Error (throw). The Error
 * may carry `status`/`stdout`/`stderr` properties for code paths that
 * read them off `e.stderr`/`e.status`.
 */
export type ExecHandler = (cmd: string) => string | Error;

/**
 * Per-pattern handler for `spawnSync` — match against `[cmd, ...args].join(" ")`.
 * Returns either a status code (0=success) or a partial result with stderr/stdout.
 */
export type SpawnHandler = (cmd: string, args: string[]) => number | { status: number; stderr?: string; stdout?: string };

export type MockDepsOptions = {
  /**
   * Pattern → handler for execSync. First matching pattern wins.
   * Unknown commands return empty string (success). To make a command
   * throw, return an Error from the handler.
   */
  execImpls?: Record<string, ExecHandler>;
  /**
   * Pattern → handler for spawnSync. Same matching as execImpls.
   * Unknown commands return `{ status: 0 }`.
   */
  spawnImpls?: Record<string, SpawnHandler>;
  /**
   * Result `runClaudeStreaming` returns. Either a fixed value or a
   * function (called per invocation, so successive streams can differ).
   * Defaults to a clean success result.
   */
  streamResult?: StreamResult | (() => StreamResult);
  /**
   * Filesystem fixture. `existsSync(path)` returns true iff path is a
   * key. `readFileSync(path)` returns the value. `writeFileSync` /
   * `mkdirSync` / `symlinkSync` are recorded but not applied to the
   * map (tests assert via `calls.fs`).
   */
  fsMap?: Record<string, string>;
  /**
   * `buildPromptForAgent` mock return. Defaults to a stable string
   * containing the issue number for round-trip assertion if needed.
   */
  buildPromptResult?: string | ((agent: AgentConfig, item: ProjectItem) => string);
};

export function makeMockDeps(opts: MockDepsOptions = {}): { deps: DispatchDeps; calls: CallLog } {
  const calls = emptyCallLog();
  const fsMap = { ...(opts.fsMap ?? {}) };

  const execImpls = opts.execImpls ?? {};
  const spawnImpls = opts.spawnImpls ?? {};

  const findExecHandler = (cmd: string): ExecHandler | undefined => {
    for (const [pattern, handler] of Object.entries(execImpls)) {
      if (cmd.includes(pattern)) return handler;
    }
    return undefined;
  };
  const findSpawnHandler = (cmd: string, args: string[]): SpawnHandler | undefined => {
    const joined = [cmd, ...args].join(" ");
    for (const [pattern, handler] of Object.entries(spawnImpls)) {
      if (joined.includes(pattern)) return handler;
    }
    return undefined;
  };

  const mockExecSync = ((cmd: string, execOpts?: any) => {
    calls.exec.push({ cmd, opts: execOpts });
    const handler = findExecHandler(cmd);
    const result = handler ? handler(cmd) : "";
    if (result instanceof Error) throw result;
    // Mimic real execSync: return string when encoding is set, Buffer otherwise.
    return execOpts?.encoding ? result : Buffer.from(result);
  }) as unknown as typeof import("node:child_process").execSync;

  const mockSpawnSync = ((cmd: string, args: string[], spawnOpts?: any) => {
    calls.spawn.push({ cmd, args, opts: spawnOpts, input: spawnOpts?.input });
    const handler = findSpawnHandler(cmd, args);
    const raw = handler ? handler(cmd, args) : 0;
    const result = typeof raw === "number" ? { status: raw } : raw;
    return {
      status: result.status,
      signal: null,
      pid: 12345,
      output: [null, Buffer.from(result.stdout ?? ""), Buffer.from(result.stderr ?? "")],
      stdout: Buffer.from(result.stdout ?? ""),
      stderr: Buffer.from(result.stderr ?? ""),
    };
  }) as unknown as typeof import("node:child_process").spawnSync;

  const mockExistsSync = ((path: string) => {
    calls.fs.push({ kind: "exists", path: String(path) });
    return Object.prototype.hasOwnProperty.call(fsMap, String(path));
  }) as unknown as typeof import("node:fs").existsSync;

  const mockReadFileSync = ((path: string) => {
    calls.fs.push({ kind: "read", path: String(path) });
    if (!Object.prototype.hasOwnProperty.call(fsMap, String(path))) {
      const e: NodeJS.ErrnoException = Object.assign(
        new Error(`ENOENT: no such file or directory, open '${path}'`),
        { code: "ENOENT", errno: -2 },
      );
      throw e;
    }
    return fsMap[String(path)];
  }) as unknown as typeof import("node:fs").readFileSync;

  const mockWriteFileSync = ((path: string, content: any) => {
    calls.fs.push({ kind: "write", path: String(path), content: String(content) });
  }) as unknown as typeof import("node:fs").writeFileSync;

  const mockMkdirSync = ((path: string) => {
    calls.fs.push({ kind: "mkdir", path: String(path) });
    return undefined;
  }) as unknown as typeof import("node:fs").mkdirSync;

  const mockSymlinkSync = ((target: string, path: string) => {
    calls.fs.push({ kind: "symlink", path: String(path), target: String(target) });
  }) as unknown as typeof import("node:fs").symlinkSync;

  const defaultStream: StreamResult = {
    output: "agent finished cleanly",
    sessionId: "sess-test-001",
    isError: false,
    numTurns: 12,
    totalCostUsd: 0.42,
    durationMs: 8_000,
    usage: { input_tokens: 100, output_tokens: 200 },
    terminalReason: "stop",
    rawResult: {},
  };
  const streamResolver = opts.streamResult ?? defaultStream;
  const mockRunClaudeStreaming = (async (..._args: any[]) => {
    calls.claudeStreams += 1;
    return typeof streamResolver === "function" ? streamResolver() : streamResolver;
  }) as unknown as DispatchDeps["runClaudeStreaming"];

  const mockNotifyDiscord = async (msg: string): Promise<void> => {
    calls.discord.push(msg);
  };

  const mockBuildPromptForAgent = (async (agent: AgentConfig, item: ProjectItem) => {
    if (typeof opts.buildPromptResult === "function") {
      return opts.buildPromptResult(agent, item);
    }
    return opts.buildPromptResult ?? `# Mock prompt for #${item.issueNumber} (${agent.name})`;
  }) as unknown as DispatchDeps["buildPromptForAgent"];

  const deps: DispatchDeps = {
    execSync: mockExecSync,
    spawnSync: mockSpawnSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    symlinkSync: mockSymlinkSync,
    runClaudeStreaming: mockRunClaudeStreaming,
    notifyDiscord: mockNotifyDiscord,
    buildPromptForAgent: mockBuildPromptForAgent,
  };

  return { deps, calls };
}

/**
 * Construct an `execSync`-style error with `status`/`stderr`/`stdout`
 * properties so failure-path code (`e?.stderr?.toString()`,
 * `e?.status`) sees the expected shape.
 */
export function execError(opts: { message?: string; status?: number; stderr?: string; stdout?: string }): Error {
  const e = new Error(opts.message ?? "Command failed");
  Object.assign(e, {
    status: opts.status ?? 1,
    stderr: Buffer.from(opts.stderr ?? ""),
    stdout: Buffer.from(opts.stdout ?? ""),
  });
  return e;
}

// --------- Mock GitHub client ---------

/**
 * In-memory `DispatchClient` for tests. Records every method call
 * AND maintains an items map so subsequent reads see the writes.
 *
 * `addLabel`/`removeLabel` mutate `labelsByIssue`; `getIssueLabels`
 * reads it. `addComment` is recorded but doesn't synthesize state.
 * `getItemStatus` reads a configurable `statusByIssue` map (and
 * defaults to `defaultStatus` when an issue is missing — most tests
 * don't care about column moves).
 *
 * Failure injection: set `failures.<method>` to an Error to make that
 * method throw. The `addLabel` failure has the "salvage cannot proceed
 * safely" coverage path; the `addComment` failure surfaces in the
 * dispatcher's error-path silent catch.
 */
export class MockGitHubClient implements DispatchClient {
  labelsByIssue: Map<number, string[]>;
  statusByIssue: Map<number, string | null>;
  defaultStatus: string | null;
  comments: { issueNumber: number; body: string }[] = [];
  addLabelCalls: { issueNumber: number; label: string }[] = [];
  removeLabelCalls: { issueNumber: number; label: string }[] = [];
  getItemStatusCalls: { issueNumber: number; forceRefresh: boolean | undefined }[] = [];
  getIssueLabelsCalls: number[] = [];
  failures: {
    addLabel?: Error | ((issueNumber: number, label: string) => Error | null);
    removeLabel?: Error;
    addComment?: Error;
    getIssueLabels?: Error;
    getItemStatus?: Error;
  } = {};

  constructor(opts: { labels?: Record<number, string[]>; status?: Record<number, string | null>; defaultStatus?: string | null } = {}) {
    this.labelsByIssue = new Map(Object.entries(opts.labels ?? {}).map(([k, v]) => [parseInt(k, 10), [...v]]));
    this.statusByIssue = new Map(Object.entries(opts.status ?? {}).map(([k, v]) => [parseInt(k, 10), v]));
    this.defaultStatus = opts.defaultStatus ?? null;
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    this.addLabelCalls.push({ issueNumber, label });
    if (typeof this.failures.addLabel === "function") {
      const e = this.failures.addLabel(issueNumber, label);
      if (e) throw e;
    } else if (this.failures.addLabel) {
      throw this.failures.addLabel;
    }
    const cur = this.labelsByIssue.get(issueNumber) ?? [];
    if (!cur.includes(label)) cur.push(label);
    this.labelsByIssue.set(issueNumber, cur);
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    this.removeLabelCalls.push({ issueNumber, label });
    if (this.failures.removeLabel) throw this.failures.removeLabel;
    const cur = this.labelsByIssue.get(issueNumber) ?? [];
    this.labelsByIssue.set(issueNumber, cur.filter(l => l !== label));
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    this.comments.push({ issueNumber, body });
    if (this.failures.addComment) throw this.failures.addComment;
  }

  async getIssueLabels(issueNumber: number): Promise<string[]> {
    this.getIssueLabelsCalls.push(issueNumber);
    if (this.failures.getIssueLabels) throw this.failures.getIssueLabels;
    return [...(this.labelsByIssue.get(issueNumber) ?? [])];
  }

  async getItemStatus(issueNumber: number, options?: { forceRefresh?: boolean }): Promise<string | null> {
    this.getItemStatusCalls.push({ issueNumber, forceRefresh: options?.forceRefresh });
    if (this.failures.getItemStatus) throw this.failures.getItemStatus;
    if (this.statusByIssue.has(issueNumber)) return this.statusByIssue.get(issueNumber)!;
    return this.defaultStatus;
  }
}

// --------- Factories ---------

export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements Go code with tests",
    usesWorktree: true,
    producesCommits: true,
    ...overrides,
  };
}

export function makeProjectItem(overrides: Partial<ProjectItem> = {}): ProjectItem {
  const blockedBy: BlockerInfo[] = overrides.blockedBy ?? [];
  return {
    id: overrides.id ?? "PVTI_test",
    issueId: overrides.issueId ?? "I_test",
    issueNumber: overrides.issueNumber ?? 100,
    title: overrides.title ?? "Test ticket",
    body: overrides.body ?? "Body of test ticket",
    status: overrides.status ?? "In Development",
    labels: overrides.labels ?? [],
    url: overrides.url ?? "https://github.com/test/repo/issues/100",
    blockedBy,
  };
}

/**
 * Convenience wrapper around `makeDispatchContext` that builds a fresh
 * agent + item + mock client + mock deps. Tests override per-field via
 * the `overrides` arg; everything else gets sensible defaults (developer
 * agent, ticket #100 in In Development, empty client state).
 *
 * Returns the context plus the underlying `client` and `calls` so tests
 * can mutate / assert on them without separate factory invocations.
 */
export function makeTestContext(overrides: {
  agent?: Partial<AgentConfig>;
  item?: Partial<ProjectItem>;
  client?: MockGitHubClient;
  deps?: DispatchDeps;
  calls?: CallLog;
  mockOptions?: MockDepsOptions;
} = {}): {
  ctx: DispatchContext;
  client: MockGitHubClient;
  calls: CallLog;
} {
  const agent = makeAgentConfig(overrides.agent ?? {});
  const item = makeProjectItem(overrides.item ?? {});
  const client = overrides.client ?? new MockGitHubClient();

  // Either (a) caller supplies pre-built deps + calls (e.g. shared
  // across multiple ctxs), or (b) we mint fresh deps from mockOptions.
  let deps: DispatchDeps;
  let calls: CallLog;
  if (overrides.deps && overrides.calls) {
    deps = overrides.deps;
    calls = overrides.calls;
  } else {
    const mock = makeMockDeps(overrides.mockOptions ?? {});
    deps = mock.deps;
    calls = mock.calls;
  }

  const ctx = makeDispatchContext(agent, item, client, deps);
  return { ctx, client, calls };
}

// --------- Smoke test ---------

describe("dispatch test harness", () => {
  test("makeTestContext composes agent, item, mock client, mock deps", () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 200 },
      agent: { name: "architect", column: "In Architecture", claudeMdPath: "architect/CLAUDE.md", producesCommits: true },
    });

    // Context shape: agent + item flow through, branchName is derived,
    // useWorktree honors agent.usesWorktree, agentCwd is the worktree dir.
    assert.equal(ctx.agent.name, "architect");
    assert.equal(ctx.item.issueNumber, 200);
    assert.equal(ctx.branchName, "feature/200");
    assert.equal(ctx.useWorktree, true, "architect usesWorktree=true → context useWorktree=true");
    assert.equal(ctx.agentCwd, ctx.worktreeDir, "useWorktree=true → cwd is worktree");
    assert.ok(ctx.deps.execSync, "deps wired through");
    assert.ok(ctx.deps.runClaudeStreaming, "deps wired through");

    // Empty harness state: no execSync, no client mutations, no streams.
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.claudeStreams, 0);
    assert.equal(client.addLabelCalls.length, 0);
    assert.equal(client.comments.length, 0);
  });
});

// =====================================================================
// setupBranchAndWorktree
// =====================================================================
//
// 12 tests: 5 failure modes + 6 decisions from `decideBranchSetup` +
// orphan-worktree cleanup + codegraph soft-fails + the no-worktree
// (PO/issue-0) path. Mock granularity is per-execSync-substring so a
// test can flip "fast-forward" to "abort" by adjusting one handler.
//
// **Invariant under test (the load-bearing one):** every failure path
// in this phase posts `error:<agent>` + a comment AND returns
// `{ ok: false }` so the orchestrator skips `cleanupAfterDispatch` —
// preserving the worktree (or the absence of one) as evidence for
// human triage. The merge-conflict path is the one exception that
// cleans up its own worktree (it just succeeded creating it).

/**
 * Empty-by-default exec baseline. Mock unmatched commands return empty
 * string (success) — anything that should *succeed silently* needs no
 * entry. Tests inject failure handlers for the specific commands they
 * want to break, plus rev-parse handlers for branch-existence + SHA
 * fixtures (those need specific output, not just success).
 *
 * Earlier draft put generic patterns like `"git branch "` here to
 * "document the happy path"; that shadowed per-test overrides like
 * `"git branch feature/101 main"` because object-key iteration matches
 * the broader pattern first. Lesson: keep mock baselines small + per-test
 * overrides specific.
 */
function happyExecBaseline(): Record<string, ExecHandler> {
  return {};
}

describe("setupBranchAndWorktree — failure modes", () => {
  test("update-main-fails on worktree path → error:<agent> label + comment + {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 100 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // The first git checkout fails — typically a non-fast-forward
          // or a dirty working tree on main. Dispatch gives up before
          // touching the feature branch.
          "git checkout main && git pull": () => execError({ stderr: "error: cannot pull with rebase" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 100, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    assert.match(client.comments[0]!.body, /Failed to update main branch/);
    // Sanity: we never advanced past the checkout — no fetch, no branch,
    // no worktree add.
    assert.ok(!calls.exec.some(c => c.cmd.includes("git fetch")), "fetch should not run after checkout fail");
    assert.ok(!calls.exec.some(c => c.cmd.includes("git worktree add")), "worktree add should not run after checkout fail");
  });

  test("abort-local-ahead-of-origin → diverged commits + SHAs in comment, label, {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 155 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Both refs exist; SHAs differ; local is NOT an ancestor of
          // origin — the integrity-error path that surfaced in #155
          // (2026-05-07).
          "git rev-parse --verify feature/155": () => "",
          "git rev-parse --verify origin/feature/155": () => "",
          "git rev-parse origin/feature/155": () => "origin-sha-aaaaaaaa\n",
          "git rev-parse feature/155": () => "local-sha-bbbbbbbb\n",
          "git merge-base --is-ancestor": () => execError({ stderr: "" }),
          // The diverged-commits log capture.
          "git log --oneline -n 30": () => "bbbbbbbb local-only commit\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 155, label: "error:developer" }]);
    assert.equal(client.comments.length, 1);
    const body = client.comments[0]!.body;
    assert.match(body, /commits not present on origin/);
    // The diverged-commits + SHA blocks both surface in the comment.
    assert.match(body, /local-sha-bbbbbbbb/);
    assert.match(body, /origin-sha-aaaaaaaa/);
    assert.match(body, /Diverged commits/);
    assert.match(body, /bbbbbbbb local-only commit/);
    // No worktree creation should follow an integrity-error abort.
    assert.ok(!calls.exec.some(c => c.cmd.includes("git worktree add")));
  });

  test("git branch creation throws → caught, label + comment + {ok:false}", async () => {
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 101 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Neither ref exists → create-from-main path.
          "git rev-parse --verify feature/101": () => execError({ stderr: "fatal: need a single revision" }),
          "git rev-parse --verify origin/feature/101": () => execError({ stderr: "fatal: need a single revision" }),
          // The `git branch <name> main` itself fails (e.g. permission /
          // index lock / corrupted refs).
          "git branch feature/101 main": () => execError({ stderr: "fatal: cannot lock ref" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 101, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Failed to set up branch/);
    assert.match(client.comments[0]!.body, /create-from-main/);
  });

  test("git worktree add fails → label + comment + {ok:false}", async () => {
    const { ctx, client } = makeTestContext({
      item: { issueNumber: 102 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/102": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/102": () => execError({ stderr: "fatal" }),
          "git worktree add": () => execError({ stderr: "fatal: '<path>' already exists" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 102, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Failed to create git worktree/);
  });

  test("merge-conflict on main → main feature → git merge --abort runs, worktree cleaned up inline, label + comment + {ok:false}", async () => {
    const { ctx, client, calls } = makeTestContext({
      item: { issueNumber: 103 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/103": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/103": () => execError({ stderr: "fatal" }),
          // worktree creation succeeds, but the post-create merge fails.
          "git merge main --no-edit": () => execError({ stderr: "CONFLICT (content): Merge conflict in foo.go" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: false });
    assert.deepEqual(client.addLabelCalls, [{ issueNumber: 103, label: "error:developer" }]);
    assert.match(client.comments[0]!.body, /Merge conflict on branch/);

    // The merge-conflict path is special: it just successfully created
    // the worktree, so it cleans up its own worktree inline. Two markers:
    //   1. `git merge --abort` runs (drains the failed merge state)
    //   2. `git worktree remove --force` runs AFTER `git worktree add`
    assert.ok(
      calls.exec.some(c => c.cmd.includes("git merge --abort")),
      "merge-conflict path must call `git merge --abort`",
    );
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    const removeAfterAdd = calls.exec.slice(addIdx + 1).some(c => c.cmd.includes("git worktree remove --force"));
    assert.ok(removeAfterAdd, "merge-conflict path must clean up its own worktree after creating it");
  });
});

describe("setupBranchAndWorktree — decideBranchSetup branches", () => {
  test("create-from-main → `git branch <name> main` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 110 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/110": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/110": () => execError({ stderr: "fatal" }),
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch feature/110 main"),
      "expected `git branch feature/110 main` exactly",
    );
  });

  test("create-from-origin → `git branch <name> origin/<name>` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 111 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          // Local missing, remote present (recovery from prior dispatcher
          // wipe — origin is canonical).
          "git rev-parse --verify feature/111": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/111": () => "",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch feature/111 origin/feature/111"),
      "expected `git branch feature/111 origin/feature/111` exactly",
    );
  });

  test("fast-forward-from-origin → `git branch -f <name> origin/<name>` invoked", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 112 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/112": () => "",
          "git rev-parse --verify origin/feature/112": () => "",
          // SHAs differ, local IS an ancestor of origin — fast-forward path.
          "git rev-parse origin/feature/112": () => "newer-origin-sha\n",
          "git rev-parse feature/112": () => "older-local-sha\n",
          "git merge-base --is-ancestor": () => "",  // exits 0 → ancestor
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.ok(
      calls.exec.some(c => c.cmd === "git branch -f feature/112 origin/feature/112"),
      "expected `git branch -f feature/112 origin/feature/112` exactly",
    );
  });

  test("reuse-local-already-synced → no `git branch ...` invoked (no-op sync)", async () => {
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 113 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/113": () => "",
          "git rev-parse --verify origin/feature/113": () => "",
          // SHAs equal → reuse local, no branch mutation needed.
          "git rev-parse origin/feature/113": () => "matching-sha\n",
          "git rev-parse feature/113": () => "matching-sha\n",
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    // No `git branch <name> ...` mutation should happen — local is already canonical.
    const branchCmds = calls.exec.filter(c =>
      /^git branch (?!-f )(feature\/113|-f feature\/113)/.test(c.cmd),
    );
    assert.equal(branchCmds.length, 0, "reuse-local-already-synced must not invoke git branch");
  });
});

describe("setupBranchAndWorktree — coverage edges", () => {
  test("orphan worktree on same branch → removed before `git worktree add`", async () => {
    // The 2026-05-02 lesson: a previous cycle's worktree (e.g.
    // `architect-100`) on `feature/100` was never cleaned up; this
    // cycle wants `developer-100` on the same branch. Without orphan
    // cleanup, `git worktree add` fails with "branch is already checked
    // out at <other-path>", error:<agent> applied, dispatcher stuck.
    // The orphan loop should remove it BEFORE adding the new worktree.
    const orphanPath = "/tmp/.pyrycode-worktrees/architect-114";
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 114 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/114": () => "",
          "git rev-parse --verify origin/feature/114": () => "",
          "git rev-parse origin/feature/114": () => "same\n",
          "git rev-parse feature/114": () => "same\n",
          "git worktree list --porcelain": () =>
            `worktree ${orphanPath}\nHEAD abc123\nbranch refs/heads/feature/114\n\n`,
        },
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    // The orphan-removal call must precede the worktree-add call.
    const orphanRemoveIdx = calls.exec.findIndex(c =>
      c.cmd.includes(`git worktree remove --force "${orphanPath}"`),
    );
    const addIdx = calls.exec.findIndex(c => c.cmd.includes("git worktree add"));
    assert.ok(orphanRemoveIdx >= 0, "orphan worktree removal must happen");
    assert.ok(addIdx > orphanRemoveIdx, "orphan removal must precede `git worktree add`");
  });

  test("codegraph symlink — source missing → warn, no symlink, still {ok:true}", async () => {
    // `decideCodegraphSymlink({sourceExists:false, destExists:false})`
    // returns `skip / no-source` — caller should warn but not fail.
    const { ctx, calls } = makeTestContext({
      item: { issueNumber: 115 },
      mockOptions: {
        execImpls: {
          ...happyExecBaseline(),
          "git rev-parse --verify feature/115": () => execError({ stderr: "fatal" }),
          "git rev-parse --verify origin/feature/115": () => execError({ stderr: "fatal" }),
        },
        // fsMap empty → existsSync returns false for everything,
        // including the .codegraph source.
        fsMap: {},
      },
    });

    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true }, "missing codegraph source must not block dispatch");
    // No symlink should have been issued — the existsSync check on the
    // source returned false (empty fsMap), so decideCodegraphSymlink
    // returns skip/no-source.
    assert.equal(
      calls.fs.filter(c => c.kind === "symlink").length,
      0,
      "no symlinkSync should be invoked when source is missing",
    );
  });

  test("PO / issue-0 path → `git checkout main && git pull` only, returns {ok:true}", async () => {
    // PO has `usesWorktree: false`. The setup phase should short-circuit:
    // pull main, return ok. No fetch, no branch ops, no worktree creation.
    const { ctx, client, calls } = makeTestContext({
      agent: { name: "po", column: "Backlog", claudeMdPath: "po/CLAUDE.md", usesWorktree: false, producesCommits: false },
      item: { issueNumber: 116 },
      mockOptions: { execImpls: happyExecBaseline() },
    });

    assert.equal(ctx.useWorktree, false, "PO ctx must have useWorktree=false");
    const result = await setupBranchAndWorktree(ctx);

    assert.deepEqual(result, { ok: true });
    assert.equal(client.addLabelCalls.length, 0, "PO success path must not label");
    assert.equal(client.comments.length, 0, "PO success path must not comment");
    // The only git command should be the checkout/pull.
    const gitCmds = calls.exec.filter(c => c.cmd.startsWith("git"));
    assert.equal(gitCmds.length, 1, "PO path runs exactly one git command");
    assert.equal(gitCmds[0]!.cmd, "git checkout main && git pull");
  });
});
