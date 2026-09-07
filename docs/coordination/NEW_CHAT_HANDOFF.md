# New task handoff — Tinglan

Give the new Codex task this local file:
`C:/Users/HP/Documents/vibe Coding/Tinglan/SKILL.md`

Canonical accepted repository:
`C:/Users/HP/Documents/11/lectureflow-local`

Do not resume old CORE-001/AI-001/COURSE-001 tasks as if they were unfinished. Read the live queue and current status first.

Suggested initial message:

> Read the supplied Skill and the canonical AGENTS.md, project-coordination Skill/protocol and PROJECT_STATUS.md in lectureflow-local. Run doctor/status. Propose an explicit bounded task for the change I assign, create a dedicated codex/<task-id> worktree from accepted main, claim the correct non-overlapping scope, and verify with real inputs. Do not modify another task's checkout or open unapproved runtime ports. Checkpoint, commit and publish; only the integration task accepts changes to main.

The shared folder is a **metadata journal**, not another code repository. `LIVE_STATUS.json` updates on coordination events and status reads. Git hooks publish commit events automatically. Changes become accepted only after integration gates pass.

The formal app uses 4318; the local Codex bridge uses 4319. Task previews use allocated 44xx/45xx ports. Never terminate another task's process to steal its port.

For active parallel UI and functionality work, keep their path scopes disjoint. Shared App/types/db changes are integration-owned. At a clean boundary use `sync -TaskId ID -Apply` to consume accepted updates; never auto-stash or overwrite dirty files.
