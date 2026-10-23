# Correction-agent diagnostics (experimental)

The default correction loop exports process status, byte counts and a bounded failure hint. It does not retain the agent's stdout/stderr. To investigate a reproducible failure, explicitly opt in:

```sh
amabie prompt-evidence loop --request request.json --agent codex \
  --authorize-corrections --max-corrections 1 --retain-agent-output --json
```

The same flag works with the Claude profile or a custom process adapter. Provider authorization, account quota and billing conditions are unchanged. This flag does not start a provider by itself or waive the correction authorization requirement.

Each executed version preflight, capability preflight or correction process gets a unique directory in the original project's `.amabie/agent-output/`. It contains UTF-8 `stdout.log`, `stderr.log` and a final `process.json` with exit status, failure flags, exact stored-text byte counts and SHA-256 digests. The JSON command response contains paths and stage/cycle metadata in `agentOutputLogs`, not raw agent text. Files are exclusively created and flushed. Existing files are not overwritten, and linked state/log directories are refused. A requested retention failure stops the loop transparently before another verification/correction cycle.

These are **untrusted diagnostics, never verification evidence**. A claim in a log cannot satisfy a requirement, replace a fresh sealed check or override a deterministic refusal. Hashes detect changes relative to the recorded metadata; they are not independent signatures. A same-user process can alter both files and metadata. This remains LOCAL.

The existing process output limits and maximum of three correction cycles still apply. Corrections are limited to 1 MiB of combined captured text per process; preflights have their smaller existing limits. No extra model calls or automatic retries are added. The logs persist across invocations until the operator removes them; they do not rely on the temporary-directory lifetime.

**Privacy:** output can contain source code, personal data or credentials printed by an agent. Use a private project directory, inspect before sharing, and delete logs after diagnosis according to your own retention policy. POSIX files/directories are created with modes 0600/0700. Windows uses inherited filesystem ACLs; this feature does not establish an independent ACL/isolation boundary. Amabie's repository ignores `.amabie/`; do not include that directory in a public export. No automatic upload, remote telemetry or redaction guarantee is provided.

The correction agent edits a disposable candidate seeded with the original project's Git-visible changes; ignored files are not copied. Results are inspected and freshly verified there. Nothing is automatically adopted into the original project. Retaining diagnostics does not change this behavior and does not turn the candidate into an OS sandbox.
