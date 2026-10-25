# Shared conformance suite

Language-neutral fixtures that pin the telemetry contract of **opentel-mcp core (JS)** and make the
**Python port** (`packages/python`) prove it matches. Design: [ADR 028](../docs/adr/028-python-port.md),
Decision 6.

JS is the source of truth. Every `expect` value below was produced by running the **unmodified** core
functions; nothing in here is hand-computed except `cases/thrown.py.json`.

```
conformance/
  contract.json            span/attribute/metric names, units, descriptions, label keys, allowlists, caps
  patterns.json            the SECRET_STEPS / NORMALIZE_STEPS / classifier regex sources and flags, and the
                           classifier name/code/status tables (so a regex edit in core is visible to Python)
  cases/
    normalize.json         raw message  -> scrubbed text, normalized message
    tool-error.json        isError result + context -> fingerprint, signature, category, channel, span attributes
    channel.json           result / {code, message} -> failure channel
    classify.json          stack-less thrown record (name/code/status/message) -> category, fingerprint, channel
    error-recording.json   (mode, error) -> exception event, status message, error.type
    thrown.py.json         Python only: synthetic frames -> stack signature, fingerprint (hand-written)
  gen_thrown_py.py         writes cases/thrown.py.json
```

## Case format

```json
{ "id": "...", "input": { ... }, "ctx": { "toolName": "...", "origin": "tool_error", "cwd": "/fixed/cwd" },
  "expect": { ... }, "languages": ["js", "py"] }
```

`languages` says which implementations must pass the case. Strings containing lone surrogates use `\uXXXX`
escapes, which both `JSON.parse` and `json.loads` preserve.

## Who asserts what

| | |
|---|---|
| JS | `packages/core/test/conformance.test.js` runs every `js` case against core; `conformance.contract.test.js` asserts `contract.json` equals what core exports and registers |
| Python | `packages/python/tests/conformance/` runs every `py` case; `tests/test_contract.py` mirrors `contract.json`; `test_regex_source_parity.py` compares the Python regex tables to `patterns.json` |

## Regenerating

Whenever core's behaviour, a regex or the contract changes on purpose:

```sh
node packages/core/scripts/gen-conformance.mjs          # rewrite the fixtures from current core
node packages/core/scripts/gen-conformance.mjs --check  # CI: fail if they are stale
```

The JS tests fail until the files are regenerated, and the regenerated diff is what tells the Python port
what to follow. Reviewers: **a diff in this directory is a contract change.**

## Adding a case

Add the *input* to the matching list in `packages/core/scripts/gen-conformance.mjs`, regenerate, and commit
both. Never edit an `expect` by hand: if core is wrong, fix core. Python-only stack cases go in
`gen_thrown_py.py`.

## Documented differences (not failures)

* `mcp.failure.validation_paths` (ADR 009) is deferred in Python (`contract.json` → `span.deferredInPython`).
* Thrown-error fingerprints and stack signatures can never equal JS ones (a Python traceback is not a V8
  stack); they are covered by `thrown.py.json` instead.
* `error-recording.json` cases whose JS error has no `name` are `js`-only (a Python exception always has one).
