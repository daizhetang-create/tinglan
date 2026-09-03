---
name: project-coordination
description: Coordinate two or more Codex chats, branches, or Git worktrees working concurrently on Tinglan. Use for task claims, UI and runtime parallel work, status synchronization, handoffs, ready-queue publication, integration, or conflict prevention. Do not use for an ordinary single-chat read-only request.
---

# Project Coordination

Keep `main` as the only accepted product state. A conversation, copied folder, or uncommitted working tree is never the source of truth.

## Start or resume work

1. Locate the repository root and run `npm run coord -- doctor`, then `npm run coord -- status`.
   If the worktree has no `node_modules`, run `npm ci` before product checks.
2. Read `docs/coordination/PROJECT_STATUS.md` and the assigned file in `docs/coordination/tasks/`.
3. Work only on the task's dedicated `codex/<task-id-lowercase>` branch or worktree. If the task has no branch yet, create it from current `main`.
4. Run `npm run coord -- claim -TaskId <ID> -Scope <scope>` before editing. Use the scope declared by the task; do not broaden it silently.
5. Run `npm run coord -- sync -TaskId <ID> -Apply` only at a clean worktree boundary. Re-run `status` at the start of each new user turn or after another workstream is integrated.

The claim output provides a worktree-specific dev port. Start Vite with `npm run dev -- --port <port>` so parallel previews do not collide.

## Complete and publish

1. Run `npm run coord -- checkpoint -TaskId <ID>` and satisfy the task's additional acceptance criteria.
2. Commit all intended changes. Do not include unrelated files.
3. Run `npm run coord -- publish -TaskId <ID> -Summary "concise verified result"`. This runs gates, records the handoff, and publishes an atomic `refs/codex/ready/<task-id>` ref.
4. Keep or release the lease as directed by the integrator. Report the ready SHA, branch, and verification results.

Only an integration worktree on `main` may run `integrate`. Other tasks learn about accepted changes through `status` and synchronize at their next clean boundary.

After changing the coordination protocol itself, run the isolated lifecycle test:

```powershell
pwsh -NoProfile -File .agents/skills/project-coordination/scripts/self_test.ps1
```

## Hard safety rules

- Never let two chats write the same checkout.
- Never merge, rebase, reset, checkout over files, or auto-stash a dirty worktree.
- Never bypass an active overlapping lease or an `integrationOnly` path.
- Never claim completion from UI state, TypeScript compilation, or mock data alone. Use the acceptance criteria and real audio fixtures where required.
- Never put ChatGPT tokens, API keys, or App Server transport secrets in the repository or browser bundle.
- If integration conflicts or checks fail, abort the integration and return the task to its owner. Do not resolve product behavior by guessing.

Read [references/protocol.md](references/protocol.md) when creating a task, integrating a ready change, resolving a lease, or diagnosing coordination failures.
