# Lattis

**A composable headless foundation for web applications.**

Lattis provides authentication, authorization, structured content, media and controlled extensions for content platforms, learning products and custom web applications. Build your frontend with the tools you prefer and connect it through the HTTP API.

Lattis Core uses the [MIT license](LICENSE). You can use it commercially, self-host it and build your own applications on top of it.

## What Lattis provides

- **Identity and access** — Better Auth, resource permissions, service tokens and an audit trail.
- **Content and media** — structured content, relationships, media storage and video building blocks.
- **CMS-independent migrations** — one versioned protocol for content, identities, taxonomy, media and source relationships.
- **Controlled extensions** — versioned JSON declarations that compose authorized backend operations without loading extension scripts into the application process.
- **An optional administration panel** — shared forms and consistent views for declarative extensions.
- **Developer tooling** — a guided terminal installer, CLI, database migrations and MCP integration.
- **Controlled delivery** — Geode catalog support, pinned artifacts and a separate updater for authorized application releases.

Application databases can use PostgreSQL or MariaDB. Geode is a separately maintained registry service; its server, database schema and deployment tools are not part of Core. Optional integrations, migration connectors and third-party Nodes are not bundled with Core.

## Getting started

The current version is **0.4.0-alpha.1**. The npm package and signed production distribution are not published yet; use a source checkout with repository access. Use Node.js matching `engines.node` in [package.json](package.json), npm and an existing application database.

```sh
git clone --depth 1 https://github.com/lattis-build/lattis.git
cd lattis
npm ci --ignore-scripts --no-audit --no-fund
node bin/lattis.js install ../my-app
```

The terminal installer asks for the database URL, application origin, listening address and port, owner email, frontend origins and signup policy. You can also configure a separate Admin origin, migration database credentials, database CA and mail delivery. Database URLs and tokens are hidden while typing. Authentication, vault and credential migration keys are generated locally; `.env` is written with mode `0600`.

The installer creates an independent application with an empty extension list and a pinned Core version, then installs its dependencies with scripts and npm audit disabled. It does not create a database, apply migrations or start services. From the new application directory:

```sh
cd ../my-app
npm run lattis -- db:app
npm run lattis -- db:auth
npm run lattis -- db:admin   # if using Admin
npm run lattis -- app:owner
npm run app
```

Use `npm run admin` in a separate terminal when configuring Admin. Mail delivery is needed for verified-email flows. Keep `.env`, encryption keys and service tokens outside version control.

For configuration without dependency installation, use `install ../my-app --skip-dependencies`. For an existing application, use `npm run configure`; it preserves unedited settings and keys and saves a private backup of the previous `.env` under `.lattis/config-backups`. `init DIRECTORY` creates only the project scaffold.

Automation can use `install DIRECTORY --config-file /private/setup.json`. Supply a private JSON object with `APP_DATABASE_URL` and `LATTIS_OWNER_EMAIL`; other installer fields are optional. Set its permissions to `0600`. Database credentials belong in this file, not command-line arguments. Configure production settings in an offline workspace before preparing an authorized release.

## Migrating from another application

Connectors run outside Core and translate source records into the [migration API](openapi/app.json). The same API works for CMS plugins, CLI exporters and custom applications. SDK schemas are exported as `lattis/migration-contract`.

Every batch identifies its source with `{ "system": "your-cms", "instance": "your-installation" }`. External IDs are scoped to that source. Content uses Lattis types, slugs, statuses and fields; the connector owns source-specific mapping, HTML rewriting and slug collision handling. Core does not load connector code or automatically fetch source media URLs.

| Endpoint | Purpose |
|---|---|
| `GET /api/migrations/content/cursor` | Read a content stream checkpoint. |
| `POST /api/migrations/content/batches` | Import types, terms, media references, content and relationships atomically. |
| `GET /api/migrations/users/cursor` | Read an identity stream checkpoint. |
| `POST /api/migrations/users/batches` | Import source identities without granting source roles in Lattis. |
| `POST /api/migrations/media` | Upload a supported file with a source ID and SHA-256 checksum. |
| `GET /api/migrations/media/map` | Page through source file mappings for URL rewriting. |

Cursor queries use `system`, `instance` and `importKey`. A batch includes `schemaVersion: 1`, `source`, `importKey`, `expectedCursor` and a distinct non-null `nextCursor`, including the final batch. Content and identity streams are separate. An exact retry of the latest batch is idempotent; a stale checkpoint returns a conflict. Data and its checkpoint commit together. Missing references reject the whole batch. Import users and media before content; records in the same content batch can refer to each other. For relationships across batches, first import records with associations omitted, then send the associations in a later checkpoint. Omitted associations are preserved; explicit empty arrays or a null author clear them.

Content imports need `content.import:content`; identity imports need `user.import:user`. Type definitions must match existing types; schema changes are explicit. Slug and taxonomy collisions return conflicts rather than silently changing URLs.

Verified-email linking is the default identity flow. Optional password migration uses encrypted, opaque credentials and a separately deployed, operator-controlled verifier service. Core accepts only configured algorithms and never executes source password code. The verifier receives `{schemaVersion, source, credential, password}` and returns `{ "valid": true }` or `{ "valid": false }`. Configure its URL, token and allowed algorithms with `LATTIS_IMPORT_VERIFIER_URL`, `LATTIS_IMPORT_VERIFIER_TOKEN` and `LATTIS_IMPORT_ALGORITHMS`. HTTPS is required except for loopback HTTP in development. Credentials are bound to their source identity and retired after a matching sign-in. Existing Lattis accounts cannot be replaced by an imported password.

## Upgrading from 0.3

Version 0.4 replaces the WordPress-specific migration routes and removes the Geode server from Core. Existing connectors must use protocol v1. Historical cursors are retained but new protocol streams start separately; content source mappings remain available for deduplication.

Back up the database and stop runtime services before applying `npm run lattis -- db:upgrade-migrations` with migration credentials in an offline workspace. [Upgrade SQL](db/upgrades) adds the source system to imported identities and changes their uniqueness constraint. MariaDB DDL commits implicitly. Pending v1 password envelopes require reimport through the new adapter and use verified-email linking until then; previously claimed identities are retained. Change the application's pinned Core dependency and `lattis.lock` together and assemble a new reviewed release.

## Extending an application

```sh
npm run lattis -- extension:new @owner/example extensions/example.json
```

A declaration defines input and output fields, permitted Node calls and views rendered by the standard panel. Each call uses the current user's permissions. Extensions do not supply JavaScript, HTML, CSS or installation hooks. Scaffolds start with `UNLICENSED` so you can choose your own license.

Declarative extensions require the separate expression runner. In development, create a private socket directory and set the same absolute `LATTIS_RUNNER_SOCKET` path for Core and the runner:

```sh
node node_modules/lattis/runner/extension-runner.mjs
```

Run that process separately from the application server. TypeScript Node and Shard scaffolds are development tools; production releases do not load them. Downloading a Geode artifact does not authorize or execute it.

## Deployment

Production uses an independently installed updater, protected trust policies and a signed inventory of the complete application and its dependencies. Application code is read-only to the runtime account; writable data and secrets live outside the release directory.

The [deployment directory](deployment) contains templates for the application, Admin, expression runner, integrity observation and an Nginx/ModSecurity/OWASP CRS edge. Adapt them to your infrastructure, keep backend ports private and provide trust anchors, owner approvals and release review evidence. Example policies contain placeholders and cannot authorize deployment as supplied. Production database TLS requires an operator-provisioned CA and separate runtime and migration principals.

The [separate updater](updater) stages and activates authorized application releases. Geode uses its own service artifact and deployment process. Neither service requires a Git checkout on the production host.

This alpha has not been validated for production use. Source changes in 0.4 have not been tested or built. Signed artifacts establish provenance and file integrity; they do not guarantee the absence of vulnerabilities. Validate deployment templates on the target infrastructure before public use.

## License

[MIT](LICENSE) — Copyright © 2026 **#1 GROUP PROSTA SPÓŁKA AKCYJNA**. Dependencies retain their own licenses.
