# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two codebases in one repo

1. **farmOS** (everything except `tools/`) — a Drupal 11 installation profile, PHP.
   Upstream project; follows Drupal conventions throughout.
2. **`tools/daily-list/`** — Mycelia, a standalone single-file HTML app. No Drupal,
   no build step, no dependencies, no shared code with farmOS. Its own conventions
   apply; see the section at the bottom.

Do not assume a change in one affects the other.

## farmOS

### Development environment

Everything runs in Docker; there is no host-level PHP toolchain. The container
bind-mounts a fully built Drupal stack at `/opt/drupal`, with this repo mounted
as the profile at `/opt/drupal/web/profiles/farm`.

    curl https://raw.githubusercontent.com/farmOS/farmOS/4.x/docker/docker-compose.development.yml -o docker-compose.yml
    docker compose up -d

The repo's `docker/` directory holds the compose files used for development,
production, and the three test matrices (mariadb, pgsql, sqlite).

### Tests, lint, static analysis

All three must pass. Run them against the profile path inside the container:

    docker compose exec -u www-data -T www phpunit  /opt/drupal/web/profiles/farm
    docker compose exec -u www-data -T www phpcs    /opt/drupal/web/profiles/farm
    docker compose exec -u www-data -T www phpstan analyze /opt/drupal/web/profiles/farm

`phpcs` printing nothing means clean. `phpcbf` auto-fixes many violations.

Narrow a PHPUnit run by path or filter — a whole-profile run is slow:

    docker compose exec -u www-data -T www phpunit /opt/drupal/web/profiles/farm/modules/core/entity
    docker compose exec -u www-data -T www phpunit --filter testAssetCreation /opt/drupal/web/profiles/farm

Set `XDEBUG_MODE=off` (env var or compose) for a substantial speedup. Functional
JavaScript tests need a `selenium/standalone-chrome:4.1.2-20220217` container
reachable at hostname `chrome`, port 4444 — later Selenium images fail.

PHPStan resolves farmOS entity classes through `entity_mapping.neon` at the repo
root. A new content entity type needs an entry there or static analysis will not
understand it.

### Architecture

`farm.profile` / `farm.install` are thin; nearly all behavior lives in modules
under `modules/`, grouped by what they provide:

- `modules/core/` — the engine (~37 modules): entity plumbing, field factory,
  API, UI, map, roles, import/export, updates.
- `modules/asset/`, `modules/log/`, `modules/quantity/`, `modules/quick/`,
  `modules/taxonomy/` — the concrete bundle types built on that engine.

The data model is **Assets** (things you track) and **Logs** (things that
happened), plus Quantities, Terms, Plans and Plan Records. `docs/model/` is the
authoritative description and is worth reading before changing entity code.

**Adding an asset/log/plan type takes two files**, not a schema change:

1. `config/install/{entity}.type.{id}.yml` — the entity type config.
2. `src/Plugin/{Entity}/{Entity}Type/{Name}.php` — a bundle plugin class
   extending the corresponding `Farm*Type` base, discovered by attribute.

`modules/core/entity` (`farm_entity`) is the hub: the `*TypeManager` services
there discover bundle plugins, and `farm_field.factory` builds field definitions
so modules rarely construct `BaseFieldDefinition` by hand. Fields that apply to
every bundle of a type go in `hook_entity_base_field_info()`; bundle-specific
fields come from the bundle plugin.

When `farm_update` is enabled, **overridden configuration entities are reverted
on cache rebuild**. That makes minor config edits in a module take effect without
an update hook — but it also means adding or removing config needs an explicit
`hook_post_update_NAME()`.

### Conventions

- Drupal coding standards; `core_version_requirement: ^11` in new `*.info.yml`.
- **`CHANGELOG.md` must be updated in every pull request** — CI enforces this via
  `dangoslen/changelog-enforcer` and the PR fails without it. Follow the existing
  Keep a Changelog format under `## [Unreleased]`.
- Documentation lives in `docs/` and is published with MkDocs (`mkdocs.yml`).
  Cross-references use site-absolute paths (`/development/module/entities`), not
  relative file paths.

## Mycelia (`tools/daily-list/`)

A voice-driven daily to-do list: one `index.html` containing all markup, CSS and
JS. Open the file in a browser to develop; there is nothing to build or install.
`README.md` in that directory documents the user-facing behavior and the phrases
the parser understands.

Structure inside the single `<script>`: date/storage helpers → the natural
language parser → rendering → speech capture → sheets (review, history,
settings) → event wiring. The parser is the part with real logic; its passes run
in a fixed order (repeat → date → time → block → priority) because each one
consumes text before the next sees it, so reordering them silently changes
results.

State is a single `localStorage` key (`mycelia.v1`). Tasks carry a `date` that
is mutated forward by `roll()` when unfinished work crosses midnight; repeating
tasks are separate `templates` that spawn a dated instance per due day. Completed
tasks are never deleted — history reads them.

The page is published as a claude.ai Artifact, so it is authored as body content:
no `<!doctype>`, `<html>`, `<head>` or `<body>` tags, and external resources are
limited to the Artifact CSP allowlist (Google Fonts is permitted; most other
hosts are not).

To verify a change, extract the script and syntax-check it, then drive the page
in a real browser — the carry-over, repeat-spawn and theme paths are only
observable at runtime:

    sed -n '/^<script>/,/^<\/script>/p' tools/daily-list/index.html | sed '1d;$d' > /tmp/app.js
    node --check /tmp/app.js

Chromium is available at `/opt/pw-browsers/chromium-*/chrome-linux/chrome` for
Playwright; wrap the file in a minimal HTML skeleton first, since the Artifact
host normally supplies it.
