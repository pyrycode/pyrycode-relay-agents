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
