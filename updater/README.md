# Lattis Updater

The independent release updater and launcher for Lattis. Version **2.0.0-alpha.1** supports application release descriptors v3.

Install it separately from the application under a protected `/opt/lattis-updater` directory. Runtime accounts must not be able to modify the updater, its dependencies, installation policies or approved release directories. Private signing keys belong outside the production host.

- `stage BUNDLE AUTHORIZATION` stages an inactive release after checking its authorization and files.
- `activate RELEASE_ID` activates a staged release with the required maintenance receipt and approvals.
- `run app`, `run admin` launch authorized components as an unprivileged runtime account.
- `integrity` compares active files with the authorized inventory and reports the result.

Invoke commands through `node /opt/lattis-updater/lattis-updater.mjs`. Staging, activation and integrity observation use the protected deployment account. Runtime launch requires a separate account without root privileges.

The protected `/etc/lattis/installation.json` policy defines owner keys, approval thresholds, release locations and the required edge configuration. Declarative extensions additionally require a separately installed runner matching the authorized platform. Templates are available in the [deployment directory](../deployment).

The updater does not execute candidate hooks, apply SQL migrations, repair files or automatically roll back data. Release review and maintenance records are operator assertions, not remote attestation of infrastructure.

This is an alpha component without confirmed production readiness. See the [project README](../README.md) for the platform overview.

## License

[MIT](LICENSE) — Copyright © 2026 **#1 GROUP PROSTA SPÓŁKA AKCYJNA**. TUF and other dependencies retain their own licenses.
