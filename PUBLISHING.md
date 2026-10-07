# Publishing Lattis alpha releases

Core is published as the unscoped public npm package `lattis`. Prereleases use the `alpha` dist-tag. The current npm candidate is `0.4.0-alpha.3`; the public services remain on the separately signed `0.4.0-alpha.2` deployment.

## Package boundary

`package.json` uses an explicit `files` list. The package includes Core, SQL, web assets, OpenAPI, the expression runner, the independent updater sources, generic deployment templates, public bootstrap roots and the offline repository-signing tool. It includes MIT license files and `.env.example` placeholders.

It excludes Geode server sources, private operational records, signing keys, actual `.env` files, local applications, node_modules, Git metadata and source-release archives. Geode is maintained in its own repository. The npm package has no installation lifecycle hooks. Dependency lifecycle scripts should be disabled during installation.

## Release process

1. Update the version in `package.json`, the root entries of `package-lock.json` and `lattis.lock`. Update the README pinned version. Never replace the contents of an already published version.
2. Review the package contents, source/history exposure, installed CLI and applicable dependencies. A packaging check is not a comprehensive security audit. Follow the owner's instructions on which checks to run.
3. Package with `npm pack --ignore-scripts --pack-destination /private/release-directory`. Inspect and test that exact tarball in an isolated directory.
4. Commit the reviewed source and create its version tag. Publish the exact reviewed tarball using `npm publish /private/release-directory/lattis-VERSION.tgz --access public --tag alpha --ignore-scripts --registry=https://registry.npmjs.org/` from an authorized npm account. Complete npm-required browser authentication or 2FA as the account owner; never commit or send tokens in chat.
5. Record the npm integrity and verify the package version and `alpha` tag from the registry. An npm publication does not change the active server release or authorize execution of Geode packages.

For future releases, configure npm trusted publishing bound to this repository and a specific reviewed GitHub Actions workflow, with provenance and no long-lived publication token. The first package publication and npm account setup may require the owner. Do not claim provenance for a local publication unless an attestation was actually created.

Publishing this source distribution does not publish a new production platform inventory. Assemble and review the exact dependency closure, publish its authorized TUF targets, and obtain owner signatures for the full application release before production activation.

## 0.4.0-alpha.3 publication review — 2026-10-07

The package contents and all reachable Git history were reviewed for known credential patterns and sensitive filenames; no unresolved finding remained after checking example placeholders and an SQL identifier. GitHub had no issues, workflow runs or releases carrying additional content at review time. This limited review cannot prove the absence of every possible secret.

The tarball installed with lifecycle scripts disabled on macOS arm64 using Node 22.22.2. Its installed CLI created a project pinned to this release, generated a private configuration without connecting to a database, and preserved configuration values and keys when creating a private reconfiguration backup. New projects had empty trusted-module and extension lists. `npm audit --omit=dev` reported zero known dependency advisories at review time. No complete typecheck, build, cross-platform test or comprehensive application audit was performed. These checks do not establish production readiness or absence of malicious code.
