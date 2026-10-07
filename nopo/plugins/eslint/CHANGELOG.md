# @more-nopo/nopo-plugin-eslint

## 0.2.1

### Patch Changes

- 5171652: Stop lintBatch from validating top-level `nopo check` plan flags (`--skip-missing`, `--no-fail-fast`) as ESLint options by passing an empty `argv` into executeEslint.

## 0.2.0

### Minor Changes

- 2070f1c: Declare plan `batches` so `nopo check:lint` / `nopo lint` coalesce multi-target `plugin: eslint` command:exec nodes into one `eslint:batch` coordinator run (mirrors docker bake).

## 0.1.0

### Minor Changes

- de8f545: Add nopo-plugin-eslint with multi-target collapse into one ESLint coordinator run and failure attribution by target.
