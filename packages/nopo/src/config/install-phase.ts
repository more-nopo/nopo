/** Install phases — the platform's vocabulary for "which dependency tree". A package
 * manager owns the COMMAND. The platform owns the SHAPE: which phases exist, what each one
 * means, and how a caller asks for one. A consumer (the install script, the docker plugin,
 * any future builder) names a phase and is handed a finished command. It never composes
 */
export const INSTALL_PHASES = ["dev", "build", "prod"] as const;

export type InstallPhase = (typeof INSTALL_PHASES)[number];

/**
 * Token a phase command may use to scope itself to one workspace member.
 * Expanded here, in the platform, so no plugin needs to know that bun
 * spells this `--filter` and uv does not.
 */
export const SERVICE_DIR_TOKEN = "{service_dir}";

/** Phases that run with a service in hand, so `{service_dir}` resolves. `dev` runs against
 * the whole repo with no service, so a `{service_dir}` in a dev command can never be
 * expanded. The config schema rejects that at load time rather than emitting a literal
 * token into a shell command.
 */
export const SERVICE_SCOPED_PHASES: readonly InstallPhase[] = ["build", "prod"];

/** `prod` falls back to `build`, `build` to `dev`, and `dev` is required. That is what lets
 * `install: <string>` keep meaning "all three are this", so a package manager with nothing
 * to say about phases (uv, cargo) stays a one-liner.
 */
const FALLBACKS: Record<InstallPhase, readonly InstallPhase[]> = {
  dev: ["dev"],
  build: ["build", "dev"],
  prod: ["prod", "build", "dev"],
};

/** A package manager's install commands, one per declared phase. */
export type InstallCommands = {
  dev: string;
} & Partial<Record<InstallPhase, string>>;

/** Applies the fallback chain, then expands `{service_dir}`. The returned string is meant
 * to be executed as-is — callers do not post-process it.
 */
export function resolveInstallCommand(
  commands: InstallCommands,
  phase: InstallPhase,
  options: { serviceDir?: string } = {},
): string {
  const chain = FALLBACKS[phase];
  const command = chain.map((p) => commands[p]).find((c) => c !== undefined);

  // `dev` is required by the schema, so the chain always terminates.
  if (command === undefined) {
    throw new Error(`No install command resolves for phase "${phase}"`);
  }

  if (!command.includes(SERVICE_DIR_TOKEN)) return command;

  if (options.serviceDir === undefined) {
    throw new Error(
      `Install phase "${phase}" uses ${SERVICE_DIR_TOKEN} but no service was provided`,
    );
  }

  return command.replaceAll(SERVICE_DIR_TOKEN, options.serviceDir);
}
