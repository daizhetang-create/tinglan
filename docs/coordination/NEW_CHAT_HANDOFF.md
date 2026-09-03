# New Codex chat handoff

The repository already contains the `$project-coordination` Skill. A new chat opened inside this repository or a worktree based on `main` discovers it automatically; copying the Skill into a second location is unnecessary and can create conflicting duplicate instructions.

## Recommended first parallel task

Create a Codex worktree/branch named `codex/core-001`, then send the new chat this exact request:

```text
Use $project-coordination in this repository. Take task CORE-001 on branch codex/core-001. Run doctor and status, claim the runtime scope, inspect the task acceptance criteria, restore reliable Chinese and English transcription with real audio smoke evidence, checkpoint the work, commit it, and publish the verified handoff. Do not edit integration-only files or claim that AI Notes works until transcript segments are proven.
```

If the other chat is assigned UI work instead, use branch `codex/ui-001`. UI work must remain inside the existing UI scope and must not modify `App.tsx`; deeper component restructuring belongs to ARCH-001.

## Commands the new chat should run

```powershell
npm run coord -- doctor
npm run coord -- status
npm ci # only when this worktree does not yet have node_modules
npm run coord -- claim -TaskId CORE-001 -Scope runtime
npm run coord -- sync -TaskId CORE-001 -Apply
```

The claim command prints a unique Vite port for that worktree. Start its preview with the printed port rather than 4317/4318.

When complete:

```powershell
npm run coord -- checkpoint -TaskId CORE-001
git add <only intended files>
git commit -m "fix(runtime): restore verified transcription"
npm run coord -- publish -TaskId CORE-001 -Summary "Describe the verified outcome"
```

The original/integration chat can then run `npm run coord -- queue` and integrate only after reviewing the evidence.
