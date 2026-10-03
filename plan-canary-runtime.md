# Canary runtime support

Requirements: reuse Kubernetes deployment for a bound canary namespace. Preserve its shell, set its pod priority, and require explicit service overlays. Let an overlay exclude default secrets.

Approach: add optional runtime policies. Keep existing production and preview behavior. Test CLI deployment and cleanup through the subprocess harness. Test secret resolution through the public config API.

Tripwires: inherited production credentials, namespace deletion, namespace label replacement, missing priority, or deployment of a service without a canary overlay.

Success: new boundary tests fail first, then pass. Existing runtime and Kubernetes tests pass. Documentation and a changeset describe the opt-in behavior.
