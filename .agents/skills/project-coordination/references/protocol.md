# Tinglan coordination protocol

Read this reference only for task creation, integration, lease recovery, or coordination diagnosis.

## Sources of truth

1. Accepted product code: `main` HEAD.
2. Ready but not accepted work: `refs/codex/ready/<task-id>`.
3. Durable intent and acceptance criteria: `docs/coordination/tasks/<task-id>.json`.
4. Live operational state shared by all worktrees: `<git-common-dir>/codex-coordination/`.
5. Human project summary: `docs/coordination/PROJECT_STATUS.md`.

Do not treat chat text, a browser preview, or an uncommitted worktree as synchronized state.

## Task lifecycle

`planned -> active -> ready -> integrated`, with `blocked` allowed from any non-integrated state.

A task file owns exactly one workstream. It records the recommended branch, scope, dependencies, acceptance criteria, and verified evidence. Each task edits only its own task file; project-wide status and changelog are integration-owned.

## Leases

`claim` creates a JSON lease atomically in the shared Git common directory. A lease records task, owner, branch, worktree, base SHA, scope, permitted paths, ports, and expiry.

- Same-scope or overlapping-path active leases conflict, including integration. Integration work has an explicit narrow path scope so disjoint runtime, bridge and storage tasks can proceed in parallel.
- Integration-only files require the `integration` scope or a separately planned integration task.
- Renew a long task before expiry. To recover your own expired lease in its original branch/worktree (even if dirty), run `renew -TaskId ID -Owner ORIGINAL_OWNER -Reason "resume interrupted task"`. Renewal uses a mutex, rechecks active overlaps and validates a 15–1440 minute TTL; it cannot displace another active owner.
- An active lease cannot be broken.
- An expired lease may be broken only after the recorded worktree is clean or unavailable and a reason is supplied.

## Synchronization

`sync` refuses dirty worktrees. With `-Apply`, it merges current local `main` into the task branch. On conflict it aborts the merge and preserves the pre-sync tree. The task owner resolves the conflict in a separate explicit step.

No background watcher may modify source files. Automatic synchronization means automatic discovery of commits and ready refs plus safe-boundary synchronization—not hot-merging into an active editor.

For this installation, each coordination event/status refresh atomically mirrors accepted main, ready refs and leases into `C:/Users/HP/Documents/vibe Coding/Tinglan/LIVE_STATUS.json`. It is metadata, not another code checkout. The canonical Git common path guard prevents isolated test clones from writing that journal. Source updates still require publish, integration and a clean-boundary sync. The integration task must not edit another active task's JSON; only its owner and main's integrate operation update that record.

## Publication

`publish` requires:

- a valid task lease matching the current branch;
- a clean worktree;
- current `main` to be an ancestor of task HEAD;
- all configured checks to pass;
- a non-empty handoff summary.

It then updates the task record, commits that handoff, and atomically sets `refs/codex/ready/<task-id>` to the resulting SHA.

## Integration

Only `main` may integrate. `integrate` acquires a global integration lease, merges the ready ref without committing, runs configured checks, marks the task integrated, updates the changelog, and commits the merge. Failed checks or conflicts abort the merge. Accepted work becomes visible to other tasks through `status`; they synchronize at a clean boundary.

## Recovery

- Dirty task worktree: commit or intentionally restore it before synchronization. Never auto-stash.
- Expired lease with dirty recorded worktree: inspect and recover that work first; do not break the lease.
- Stale ready ref: publish a new verified task commit; do not force main backward.
- Failed integration: return the task to the owner with exact failing command and output.
- Corrupt shared runtime state: preserve event files, recreate only the affected expired lease, then run `doctor`.

## Definition of final consistency

- all accepted tasks are reachable from `main`;
- ready queue is empty;
- no active task leases remain;
- configured checks pass on `main`;
- task records show integrated evidence;
- the user-facing status matches observable product behavior.

After changing the coordination machinery, run `scripts/self_test.ps1`; it must print `FORWARD_TEST_PASS`.
