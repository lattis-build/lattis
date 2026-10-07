# Lattis

**A composable headless foundation for web applications.**

Lattis provides the backend foundations shared by content platforms, learning products and custom web applications: authentication, authorization, structured content, media and controlled extensions. Build your frontend with the tools you prefer and connect it through the HTTP API.

Lattis Core is available under the [MIT license](LICENSE). You can use it commercially, self-host it and build your own applications on top of it.

## What Lattis provides

- **Identity and access** — authentication with Better Auth, resource permissions, service tokens and an audit trail.
- **Content and media** — structured content, relationships, media storage and video building blocks.
- **Controlled extensions** — versioned JSON declarations that compose authorized backend operations without loading extension scripts into the application process.
- **An optional administration panel** — a consistent interface with shared forms for declarative extensions.
- **Developer tooling** — a CLI, project scaffolding, database migrations and MCP integration.
- **Controlled delivery** — Geode catalog support, pinned artifacts and a separate updater for authorized application releases.

The application database can use PostgreSQL or MariaDB. Geode uses PostgreSQL and is operated separately from an application. Optional business integrations and third-party Nodes are not bundled with Core.

## Getting started

The current version is **0.3.0-alpha.1**. Start with a local development environment. The npm package and signed production distribution are not published yet; use a source checkout with repository access.

Use Node.js matching the `engines.node` range in [package.json](package.json), npm and an application database.

```sh
git clone --depth 1 https://github.com/lattis-build/lattis.git
cd lattis
npm ci --ignore-scripts
node bin/lattis.js init ../my-app
cd ../my-app
npm install --ignore-scripts
cp .env.example .env
```

Set your database URL, a random authentication secret and the instance owner's email in `.env`:

| Variable | Purpose |
|---|---|
| `APP_DATABASE_URL` | PostgreSQL or MariaDB connection for the application. |
| `BETTER_AUTH_SECRET` | A random secret of at least 32 characters. |
| `APP_BASE_URL` | Application origin, such as `http://127.0.0.1:4100` for development. |
| `LATTIS_OWNER_EMAIL` | Email of the instance owner. |
| `LATTIS_MAIL_WEBHOOK_URL` / `LATTIS_MAIL_WEBHOOK_TOKEN` | Mail delivery for email verification and password recovery. |

Then create the application and authentication tables and start the development server:

```sh
npm run lattis -- db:app
npm run lattis -- db:auth
npm run app
```

The initializer creates an independent application directory with its own configuration, lockfile and local dependency on the Core checkout. No optional integration is installed or enabled. Keep `.env` and application secrets outside version control.

## Extending an application

Create a declarative extension using your application's `localPublisher` namespace:

```sh
npm run lattis -- extension:new @owner/example extensions/example.json
```

A declaration defines input and output fields, permitted Node calls and views rendered by the standard panel. Each call uses the current user's permissions. Extensions do not supply JavaScript, HTML, CSS or installation hooks. New scaffolds start with an `UNLICENSED` marker so you can choose the license for your own work.

Declarative extensions require the separate expression runner. In development, create a private socket directory and use the same absolute `LATTIS_RUNNER_SOCKET` path for Core and the runner:

```sh
node node_modules/lattis/runner/extension-runner.mjs
```

Run that process separately from the application server. TypeScript Node and Shard scaffolds are development tools; production releases do not load them. Downloading an artifact from Geode does not authorize or execute it.

## Deployment

Production uses an independently installed updater, protected trust policies and a signed inventory of the complete application and its dependencies. Application code is read-only to the runtime account; writable data and secrets live outside the release directory.

The [deployment directory](deployment) contains templates for the application, Admin, the isolated expression runner, integrity observation and an Nginx/ModSecurity/OWASP CRS edge. Configure these for your infrastructure, keep backend ports private and provide the required trust anchors, owner approvals and release review evidence. Example policies contain placeholders and cannot authorize a deployment as supplied.

The updater is maintained as a [separate package](updater). It stages and activates authorized releases; it does not run candidate installation hooks or automatically roll back database migrations.

This alpha has no confirmed production readiness. Signed artifacts establish provenance and file integrity; they do not guarantee the absence of vulnerabilities. Deployment templates require validation on the target infrastructure before public use.

## License

[MIT](LICENSE) — Copyright © 2026 **#1 GROUP PROSTA SPÓŁKA AKCYJNA**. Third-party dependencies retain their own licenses.
