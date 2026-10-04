---
"@more-nopo/nopo-plugin-terraform": patch
---

Add optional `plugins.terraform.volumes[].storageClassName` on declared volume claims. The claim name stays `${serviceId}-${volumeName}`. Omit `storageClassName` when the field is absent. Do not emit null.
