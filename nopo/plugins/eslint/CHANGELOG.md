# @more-nopo/nopo-plugin-eslint

## 0.2.2

### Patch Changes

- e3dab4d: Preserve each target's global ignores in batched (multi-target) lint runs. The meta config used to add a `files` glob to every config entry, which turned global-ignore entries (only `ignores`, e.g. `includeIgnoreFile(".gitignore")`) into no-op local ignores, so a root target linted `dist/` output and every nested workspace it ignores. Global ignores now stay global, rebased onto the target's root and ordered shallowest target first, with negations that re-include deeper targets' roots so a root ignore can't hide another selected target. A target's rule entries also skip the roots of deeper targets, which lint with their own config as they would in a standalone run. A config-less target nested in a selected target whose config ESLint would find for it now lints with that config (and its ignores) instead of a bare rule-less entry.

## 0.2.1

### Patch Changes

- 5171652: Stop lintBatch from validating top-level `nopo check` plan flags (`--skip-missing`, `--no-fail-fast`) as ESLint options by passing an empty `argv` into executeEslint.

## 0.2.0

### Minor Changes

- 2070f1c: Declare plan `batches` so `nopo check:lint` / `nopo lint` coalesce multi-target `plugin: eslint` command:exec nodes into one `eslint:batch` coordinator run (mirrors docker bake).

## 0.1.0

### Minor Changes

- de8f545: Add nopo-plugin-eslint with multi-target collapse into one ESLint coordinator run and failure attribution by target.
