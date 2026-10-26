# A green command that should not count

This demonstration uses the real `component/escape-html` repository at
[`b42947e`](https://github.com/component/escape-html/tree/b42947eefa79efff01b3fe988c4c7e7b051ec8d8),
with its original Mocha tests. It downloads that revision and its development
dependencies into a temporary directory, disables dependency install scripts,
and removes the directory afterwards. It changes no user project or upstream repository.

From an Amabie source checkout:

```sh
npm ci
npm run build
node examples/real-repo/reproduce.mjs docs/demo-transcript.json
```

The script first runs the original suite, then records a simulated agent change:
HTML escaping is broken and the test command is replaced with `node --version`.
The replacement command exits successfully, even after the change is committed.
Amabie's completion hook refuses it because the sealed verification authority
changed. Restoring the reviewed implementation and command lets the real tests
and completion gate pass again.

This is a deterministic anti-tampering example with a **simulated** agent
completion. It is not a measurement of how often an AI agent cheats, a
comparative benchmark, or a false-positive-rate estimate. No model is called.
