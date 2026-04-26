# AGENTS.md

## Repository purpose

This repository powers a dynamic GitHub profile README for `Johannsis`.
It is documentation-first, automation-driven, and release-managed with semantic-release.

Primary artifact:
- `README.md` (profile page content)

Automation and config:
- `.github/workflows/update-readme-with-github-activity.yml`
- `.github/workflows/automatic-release.yml`
- `.releaserc.json`
- `biome.json`
- `package.json`

## Tech and runtime baseline

- Package manager: Bun (`bun@1.3.13`)
- Node runtime target: `>=24.0.0` (with `.nvmrc` pinned to `24.15.0`)
- Lint/format: Biome v2
- Release automation: semantic-release
- License: MIT

## Local development commands

- Install deps: `bun install`
- Lint (auto-fix): `bun run lint`
- Format: `bun run format`
- Release (normally CI-only): `bun run release`

Notes:
- `lint` runs with `--fix`, so it can modify files.
- There are no unit/integration test scripts in this repository.

## CI/CD and automation behavior

### Activity updater workflow

`update-readme-with-github-activity.yml`:
- Runs on a daily cron and manual dispatch.
- Uses `jamesgeorge007/github-activity-readme` to refresh the activity section in `README.md`.
- Requires `GH_TOKEN` secret.

### Release workflow

`automatic-release.yml`:
- Runs on pushes to `main` and manual dispatch (job gated to push on `main`).
- Installs dependencies with Bun and runs semantic-release.
- Requires `GH_TOKEN` and `NODE_AUTH_TOKEN`.

### semantic-release strategy

`.releaserc.json` current behavior:
- Every commit type maps to a patch release.
- Changelog is generated.
- `npmPublish` is disabled.
- Release commit updates: `CHANGELOG.md`, `package.json`, `bun.lock`, `README.md`.

## Audit findings (current state)

1. No automated tests exist.
   - Impact: low confidence for behavior changes outside lint/format scope.
2. Lint command is mutating (`biome lint --fix`) and not a strict CI gate check.
   - Impact: contributors may commit unintended formatting edits.
3. Formatting policy mismatch.
   - `.editorconfig` enforces spaces, while Biome is configured for tabs.
   - Impact: editor and formatter can fight each other.
4. Workflow/action pinning is not strict (version tags and `master` usage).
   - Impact: supply-chain and reproducibility risk.
5. Release rule publishes patch for any commit message.
   - Impact: high release frequency and less meaningful semantic versioning.

## Agent operating guide

When making changes in this repository:

1. Keep scope tight to profile README and automation files.
2. Prefer small PRs with clear intent (content update, CI update, release config update).
3. Run `bun run lint` before proposing changes.
4. If you touched markdown heavily, run `bun run format` as final cleanup.
5. Avoid introducing non-deterministic assets or external dependencies unless required.

Commit guidance:
- Use semantic-release compatible commit syntax for all commits that will be pushed to `main`.
- Prefer conventional commit types such as `feat:`, `fix:`, `chore:`, and `docs:`.

## Recommended hardening backlog

High-value improvements:

1. Align indentation policy:
   - Choose tabs or spaces and make `.editorconfig` and `biome.json` match.
2. Split lint into check and fix scripts:
   - Example: `lint` for check-only, `lint:fix` for local autofix.
3. Pin GitHub actions to immutable SHAs.
4. Replace floating `@master` action references with stable tags/SHAs.
5. Revisit release rules to support meaningful semver bumps.

Optional improvements:

1. Add markdown linting (for link/style consistency).
2. Add link checking for README badges and external URLs.
3. Add a minimal CI validation workflow for pull requests.

## Do/Do-not summary for agents

Do:
- Preserve README visual intent and existing branding style.
- Verify changed workflows still have required secrets documented.
- Keep changes deterministic and easy to review.

Do not:
- Add app/framework scaffolding unrelated to profile README automation.
- Introduce secrets into tracked files.
- Modify release automation semantics without documenting rationale.
