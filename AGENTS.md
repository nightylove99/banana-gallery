# Banana Gallery — Contributor & Agent Guide

## Project Overview

Banana Gallery is a local-first, self-hosted AI image studio and prompt iteration workbench shared by humans (Web UI) and external AI agents (cross-platform CLI + bundled Agent Skill + `/api/v1`).

It targets **single-user self-hosting** (`AUTH_MODE=local` on loopback by default, or optional `AUTH_MODE=cloudflare_access` for private remote access). Multi-user SaaS hosting, external SQL databases, and S3 storage are intentionally out of scope.

## Hard Guardrails

- **Loopback safety**: `AUTH_MODE=local` must remain strictly loopback-only (`127.0.0.1` / `::1` / `localhost`). Never relax TLS verification or log credentials.
- **Scoped Agent access**: `BANANA_GALLERY_API_TOKEN` grants read/query, reference upload, generation task submission/polling, and recipe saving only — never destructive delete/trash, backup management, or server-side local path import.
- **Real user data protection**: `gallery-data.json`, `generation-tasks.json`, `.provider-config.json`, `.vertex-service-account.json`, `public/images/`, `public/references/`, and `.env` must never be committed or bundled into `dist/`. Tests must always use isolated temporary directories.
- **Cross-platform compatibility**: Keep `npm run build && npm start`, `npm run doctor`, `npm run update`, and `scripts/banana-gallery.py` working cleanly on Windows, macOS, and Linux.
- **Storage boundary**: Keep pure local `gallery-data.json` + disk assets. Do **not** migrate to SQLite/PostgreSQL or introduce native-compilation database dependencies unless a single-user library genuinely exceeds ~20,000 works or ~100 MB index write latency and includes a lossless migration tool.
- **Backward compatibility & zero-pain upgrades**:
  - **Data schema**: Any new, renamed, or restructured field in `gallery-data.json` must auto-migrate or fall back cleanly on read, with a unit test covering an older snapshot format. Never require users to hand-edit `gallery-data.json`.
  - **Environment variables**: Keep `.env` additive-only with safe defaults. If a variable must be renamed, continue reading the legacy name with a startup warning for at least one release cycle, and always update `.env.example`.
- **Skill & CLI sync discipline**:
  - Keep `skills/banana-gallery/SKILL.md` thin (workflow, guardrails, core commands). Never hardcode volatile model catalogs or defaults that agents can query via `models` / `--help`.
  - Whenever `/api/v1`, `scripts/banana-gallery.py`, or Agent workflows change, update `skills/banana-gallery/SKILL.md` and `doc/api-v1.md` in the same change and explicitly remind the maintainer in the delivery summary that copied-Skill users need to re-sync.

## Release Rhythm & Branching Discipline

- **`main` is always shippable**: Every commit on `main` must pass the full verification suite below so friends pulling `main` always get a working app.
- **Small fixes / targeted tweaks** (finishable and verifiable in one session) may land directly on `main`.
- **Large refactors, multi-day features, or uncertain UX changes**: Before editing, proactively propose creating an isolated branch (e.g., `feat/...`) so the maintainer can dogfood it locally for a day or two before merging to `main`. Never push unverified or half-finished large changes directly to `origin/main`.
- **Agent commits and pushes**: Agents may create local commits only after verifying the changes and must never run `git push` without explicit maintainer confirmation.
- **Release notes reminder**: When merging a meaningful change or batch of fixes to `main`, proactively draft a concise 3–5 line plain-language changelog (explicitly noting whether `.env` changes or Skill re-sync are needed) and remind the maintainer to tag / publish a GitHub Release.

## Verification Commands

Run before committing changes:

```bash
npm run typecheck
npm run test:contracts
npm run lint
npm test
npm run test:gallery-client
npm run build
```

- Before restarting a running local service, verify that no image generation tasks are queued or active.
- For UI changes, inspect the live page. For API or provider changes, verify real responses rather than relying on unit tests alone.

## Versioning

- App features/fixes update `package.json` and `package-lock.json`.
- Browser extension changes update `extension/gemini-to-banana/manifest.json`.
- Keep `skills/banana-gallery/SKILL.md` and `doc/api-v1.md` in sync whenever CLI or `/api/v1` behavior changes.
