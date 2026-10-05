# @more-nopo/nopo-plugin-terraform

## 0.0.6

### Patch Changes

- Updated dependencies [d870c71]
  - @more-nopo/nopo@0.3.0

## 0.0.5

### Patch Changes

- Updated dependencies [7bb536e]
  - @more-nopo/nopo@0.2.0

## 0.0.4

### Patch Changes

- 2c22d67: Add optional `plugins.terraform.volumes[].storageClassName` on declared volume claims. The claim name stays `${serviceId}-${volumeName}`. Omit `storageClassName` when the field is absent. Do not emit null.

## 0.0.3

### Patch Changes

- Updated dependencies [7e3dcc4]
  - @more-nopo/nopo@0.1.0

## 0.0.2

### Patch Changes

- 40bf835: Add optional runtime policies for reserved Kubernetes namespaces. Preserve the namespace shell during deployment and cleanup, set pod priority, and require explicit service overlays. Add `inherit_secrets: false` to exclude default credentials from an independent runtime.
- Updated dependencies [40bf835]
  - @more-nopo/nopo@0.0.2

## 0.0.1

### Patch Changes

- b055b85: First-party plugins on the public repo.
