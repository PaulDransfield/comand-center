# archive/

Historical files moved here in Sprint 2 Task 10 (2026-05-04). Nothing in
the running app or scripts depends on these — they're kept for git
history + occasional reference, not for active use.

## archive/migrations/

Every SQL migration ever applied (M018–M047 + a handful of pre-numbered
schema dumps and one-shot scripts). Authoritative status stays in the
root `MIGRATIONS.md` index. Open the SQL files here when you need to
read what a specific migration did.

If you need to **apply** a migration, paste the file contents into the
Supabase SQL Editor — the path move doesn't change the content.

## archive/notes/

One-shot fix narratives, old plan docs, prompt drafts, project
inventories that were written for a specific moment and have since
been superseded by the running CLAUDE.md / FIXES.md / ROADMAP.md
trio. Search them for context on a specific past incident; otherwise
they're noise.

## What still lives at the repo root

Just the active working set:

- `CLAUDE.md` — working guidelines + invariants
- `ROADMAP.md` — sprint log + active priorities
- `FIXES.md` — incident log
- `MIGRATIONS.md` — DB change log
- `LEGAL-OBLIGATIONS.md` — compliance source of truth
- `ARCHITECTURE-PLAN.md` — current architecture
- `AI-AGENTS-MASTER-PLAN.md` — AI agent inventory
- `Admin-Console-Rebuild-Plan.md` — admin V2 plan
- `DATA_SOURCES.md` — provider matrix
- `DESIGN.md` — UX spec
- `REVIEW.md` — external code review (Sprint 1+2 source)
- `README.md`, `SETUP.md`
