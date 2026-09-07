# Tinglan project instructions

The product mission is to raise Tinglan from the current broken prototype to a verified 90/100 classroom assistant. Restore the transcription-to-notes path before treating cosmetic work as product completion.

## Required coordination

When more than one Codex chat, branch, or worktree may touch this repository, use the repo skill at `.agents/skills/project-coordination/SKILL.md`.

At the start of every coding turn:

1. Run `npm run coord -- doctor` and `npm run coord -- status`.
2. Read `docs/coordination/PROJECT_STATUS.md` and the assigned task JSON.
3. Work on a dedicated `codex/<task-id-lowercase>` branch or Codex worktree. Never share a dirty checkout with another task.
4. Claim the task scope before editing: `npm run coord -- claim -TaskId <ID> -Scope <scope>`.
5. Re-run `status` before starting a new user-requested phase so newly integrated work is not missed.

Before handing off:

1. Run `npm run coord -- checkpoint -TaskId <ID>`.
2. Commit the verified change.
3. Publish it with `npm run coord -- publish -TaskId <ID> -Summary "..."`.
4. Report the exact commit SHA and checks. A chat message alone is not a handoff.

Only the integration role may merge ready work into `main`. Never auto-merge, rebase, reset, or overwrite a dirty worktree. If a scope overlaps an active lease, stop and coordinate instead of bypassing the lease.

## Product truth

- The original q8 transcription failure is fixed with verified fp32 WASM. Preserve real audio smoke gates; do not regress to q8 without fresh compatibility evidence.
- The Codex bridge is real and verified with ChatGPT-managed login. Local rules remain an explicitly labelled fallback, not GPT. Read the acceptance report for tested boundaries; do not assert perfect accuracy or long-lecture readiness without evidence.
- Keep secrets out of browser code and Git. The planned Codex integration uses App Server over a local bridge and ChatGPT-managed authentication.
- Every AI conclusion intended for the product must retain source recording and timestamp references.
- Preserve user data and unrelated work. Database schema changes require an explicit migration and a backup/restore test.

## Verification baseline

At minimum, run `npm run check` and `npm run build`. Product completion additionally requires the task-specific acceptance criteria in `docs/coordination/tasks/*.json`; a green TypeScript build alone does not prove audio or model inference works.
