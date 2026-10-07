# Official bootstrap roots

These are the initial public TUF roots provisioned for the Lattis alpha services on 2026-10-07. No private key is included.

| Channel | Origin | SHA-256 of this root file |
|---|---|---|
| Geode | `https://geode.lattis.build` | `9738648d69a580f32aa235aa04044516c57039969024ff2a2d48f8df1c5346c3` |
| Updates | `https://updates.lattis.build` | `b4a2744dd2e09c36da1246b33c839ebf8ce18da3b087a0c3ce0398134f15a070` |

Provision the roots as `/etc/lattis/geode-root.json` and `/etc/lattis/updates-root.json`, owned by root and not writable by application users. The corresponding protected trust policy contains `schemaVersion: 1`, the exact origin, `rootPath` and `rootDigest` prefixed with `sha256:`; see the sibling example policies.

Verify source provenance before trusting these keys. A fingerprint fetched from the same untrusted channel as a substituted root is not an independent trust anchor. Future root rotations require the TUF root-rotation procedure; a server response cannot replace a protected root policy by itself. Roots expire, and fresh timestamp/snapshot/targets metadata is also required by clients.
