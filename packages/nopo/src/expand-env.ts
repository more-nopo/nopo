/** Expand shell-style variable references in environment variable values. ${VAR} — replaced
 * with the value of VAR, or empty string if unset ${VAR:-default} — replaced with the
 * value of VAR, or "default" if unset/empty ${VAR-default} — replaced with the value of
 * VAR, or "default" if unset (empty is kept) $VAR — replaced with the value of VAR,
 */
export function expandEnvValues(
  values: Record<string, string>,
  env: Record<string, string | undefined>,
): Record<string, string> {
  // Build a lookup that includes process env as the base, then overlay
  // values as they are expanded (so later entries can reference earlier ones).
  const resolved: Record<string, string | undefined> = { ...env };
  const result: Record<string, string> = {};

  for (const [key, raw] of Object.entries(values)) {
    const expanded = expandString(raw, resolved);
    result[key] = expanded;
    resolved[key] = expanded;
  }

  return result;
}

/**
 * Expand shell-style variable references in a single string.
 */
export function expandString(
  input: string,
  env: Record<string, string | undefined>,
): string {
  // Match ${VAR:-default}, ${VAR-default}, ${VAR}, and $VAR
  return input.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, simple: string | undefined) => {
      if (simple !== undefined) {
        return env[simple] ?? "";
      }

      if (braced !== undefined) {
        return resolveBraced(braced, env);
      }

      return "";
    },
  );
}

/**
 * Resolve the contents inside ${...}.
 * Handles VAR, VAR:-default, and VAR-default.
 */
function resolveBraced(
  expr: string,
  env: Record<string, string | undefined>,
): string {
  // ${VAR:-default} — use default if unset OR empty
  const colonDashIdx = expr.indexOf(":-");
  if (colonDashIdx >= 0) {
    const name = expr.slice(0, colonDashIdx);
    const fallback = expr.slice(colonDashIdx + 2);
    const value = env[name];
    return value !== undefined && value !== "" ? value : fallback;
  }

  // ${VAR-default} — use default only if unset (empty string is kept)
  const dashIdx = expr.indexOf("-");
  if (dashIdx >= 0) {
    const name = expr.slice(0, dashIdx);
    const fallback = expr.slice(dashIdx + 1);
    const value = env[name];
    return value !== undefined ? value : fallback;
  }

  // ${VAR} — simple expansion
  return env[expr] ?? "";
}
