# Amabie 2.0 — public package identity

The operator selected `amabie-cli` on 25 October 2026 after npm refused creation
of the unavailable `amabie` organization. The executable remains `amabie`.
The private workspace `@amabie/cli` is unchanged; it is not a public install name.

```sh
npm install --global amabie-cli@2.0.0
amabie --version
```

This names the intended release; registry publication must be verified separately.
Local candidates remain installable from `amabie-cli-2.0.0.tgz` after verifying
the supplied SHA-256. Do not reuse the scoped candidate's checksum.

Only packaging metadata, the shipped quickstart, install-path probes and a
measurement helper change. No verifier, security boundary, verdict, timeout or
runtime API changes. Historical comparison artifacts retain their original names.
Two layout regression cases exercise the new public and historical scoped
installations and refuse missing shims or unrelated package identities.

The runtime source inherits the exact six-job successful CI evidence at
`716dcd50977583d45c74e6b28f8d8e823f41a2de`
([run 40198894607](https://github.com/criptofn/Amabie/actions/runs/40198894607)).
This is parent evidence, not an assertion that CI executed the later packaging commit.
Changed packaging requires fresh Windows/Linux clean installations, installed
verification/MCP failure-mode rehearsals and reproducibility checks.

Supported release-validation scope: Windows and Linux with Node.js 22+, npm and Git.
Native macOS full-suite coverage remains unverified; standalone build/smoke passed.
Prompt-to-Evidence and authorization remain opt-in experimental. LOCAL is not
HARDENED, and Universal Agent Assurance remains a vision. Historical host crashes
retain unknown causality; subsequent successful runs do not prove a causal cure.
No cost-gated or host-bound skipped test is counted as passed.

Do not replace operator acceptance with an AI invocation of `amabie accept`.
No private operator details or credentials belong in the package or release notes.
