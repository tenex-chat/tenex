# Migrations

This directory owns TENEX state migrations.

## High Level

- The global `config.json` stores a migration `version`.
- That `version` is a TENEX state version, not the app version.
- `bun doctor migrate` reads the current version, finds pending migrations, runs them in order, and writes the new version back to `config.json`.

## Structure

- `MigrationService.ts` only orchestrates version detection, ordering, and persistence of the new version.
- `migrations/` contains one isolated file per migration step.
- Each migration file owns the code for exactly one transition, such as `unknown -> 1`.

## Rules

- Keep each migration idempotent enough for a single controlled run.
- Do not mix unrelated migrations in one file.
- Prefer using existing services/path helpers instead of hand-building TENEX paths.
- If a migration cannot safely transform a record, skip it explicitly and report it rather than guessing.
