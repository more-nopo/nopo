# Reserved namespace fixture

`app` opts into canary deployment. `platform` does not.
The CLI contract tests load the real Kubernetes plugin with a subprocess harness.
They verify namespace preservation, priority, service filtering, and cleanup failures without cluster access.
