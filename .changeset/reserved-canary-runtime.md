---
"@more-nopo/nopo": patch
"@more-nopo/nopo-plugin-terraform": patch
---

Add optional runtime policies for reserved Kubernetes namespaces. Preserve the namespace shell during deployment and cleanup, set pod priority, and require explicit service overlays. Add `inherit_secrets: false` to exclude default credentials from an independent runtime.
