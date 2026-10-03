# Reserved Kubernetes environments

Use a named runtime for a canary that has its own namespace and credentials.
Provision its namespace, RBAC, quota, and PriorityClass before deployment.

```yaml
runtimes:
  default: docker-compose
  prod: terraform
  canary:
    plugin: terraform
    namespace: nopo-canary
    preserveNamespace: true
    priorityClassName: nopo-canary
    requireOverlay: true
```

`preserveNamespace` requires an explicit namespace.
Deployment checks that the namespace exists. It does not apply or replace namespace labels.
Cleanup deletes Deployments, Jobs, Pods, Services, secrets, ConfigMaps, PVCs, and PodDisruptionBudgets.
Cleanup reports failure if any deletion fails. It still attempts the remaining resource kinds.
It preserves the namespace, RBAC, quota, and PriorityClass.

`requireOverlay` includes only services that declare the selected runtime.
Dependencies without that overlay are excluded, even when an explicit target expands them.
The operator must provide each required dependency in the environment.

`priorityClassName` sets the priority on Deployment pods.
It does not create the PriorityClass or set priority on jobs created by applications.

Use an independent secret map on each service:

```yaml
runtime:
  default:
    command: start
  canary:
    inherit_secrets: false
    secrets:
      DATABASE_URL: ENC[encrypted-canary-credential]
```

This example shows the envelope format. Use `nopo secret set` to create a real envelope.
`inherit_secrets: false` excludes default secrets before resolving the named map.
Commands, plain environment values, processes, and other defaults still inherit.
Override production URLs and set canary dependencies explicitly.
This policy does not provide a network firewall.

Existing runtimes keep their behavior when these options are absent.
The built-in `nopo-prev` behavior remains the default for preview.
