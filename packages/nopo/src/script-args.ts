import type { Runner } from "./lib.ts";
import { minimist, type ParsedArgs } from "./lib.ts";

/**
 * Configuration for a single argument
 */
export interface ScriptArgConfig<T = unknown> {
  type: "string" | "boolean" | "number" | "string[]";
  description: string;
  alias?: string[];
  default: T;
  validate?: (value: T, runner?: Runner) => void | Promise<void>;
  hidden?: boolean; // For internal args not shown in help
}

/**
 * Container for argument definitions and parsed values
 * Provides type-safe access to command-line arguments
 */
export class ScriptArgs {
  private schema: Record<string, ScriptArgConfig>;
  private values: Record<string, unknown>;
  private runner?: Runner;

  constructor(schema: Record<string, ScriptArgConfig>, runner?: Runner) {
    this.schema = schema;
    this.runner = runner;
    this.values = {};
  }

  /**
   * Extend with additional arg definitions
   * Returns a new ScriptArgs instance with combined schema
   */
  extend(additionalSchema: Record<string, ScriptArgConfig>): ScriptArgs {
    return new ScriptArgs({ ...this.schema, ...additionalSchema }, this.runner);
  }

  /**
   * Parse argv and populate values
   */
  parse(argv: string[]): this {
    // Build minimist options from schema
    const minimistOpts = this.buildMinimistOptions();

    // Build alias mapping for normalizing single-letter flags
    // This works around minimist's quirky handling of single-letter flags
    const singleLetterAliasToKey = new Map<string, string>();
    for (const [key, config] of Object.entries(this.schema)) {
      if (config.alias) {
        for (const alias of config.alias) {
          if (alias.length === 1) {
            singleLetterAliasToKey.set(`-${alias}`, `--${key}`);
          }
        }
      }
    }

    // Normalize argv: convert single-letter aliases to long form
    // This ensures minimist respects the string/boolean type arrays
    const normalizedArgv = argv.map((arg) => {
      return singleLetterAliasToKey.get(arg) || arg;
    });

    // For string[] types, we need to manually collect values since minimist
    // doesn't handle this well with aliases. Pre-process argv to collect them.
    const arrayArgs = new Map<string, string[]>();
    const processedArgv: string[] = [];

    // Identify string[] args and their aliases
    const arrayArgNames = new Set<string>();
    const aliasToKey = new Map<string, string>();
    for (const [key, config] of Object.entries(this.schema)) {
      if (config.type === "string[]") {
        arrayArgNames.add(key);
        arrayArgs.set(key, []);
        if (config.alias) {
          for (const alias of config.alias) {
            aliasToKey.set(
              alias.length === 1 ? `-${alias}` : `--${alias}`,
              key,
            );
          }
        }
        aliasToKey.set(`--${key}`, key);
      }
    }

    // Pre-process normalized argv to collect string[] values
    let i = 0;
    while (i < normalizedArgv.length) {
      const arg = normalizedArgv[i]!;

      // Check if this is a string[] flag
      const arrayKey = aliasToKey.get(arg);
      if (arrayKey && i + 1 < normalizedArgv.length) {
        // Collect the value
        const values = arrayArgs.get(arrayKey)!;
        values.push(normalizedArgv[i + 1]!);
        i += 2; // Skip both flag and value
      } else {
        processedArgv.push(arg);
        i++;
      }
    }

    // Parse remaining args with minimist
    const parsed = minimist(processedArgv, minimistOpts);

    // Add collected array values to parsed result
    for (const [key, values] of arrayArgs.entries()) {
      if (values.length > 0) {
        parsed[key] = values;
      }
    }

    // Extract and validate each arg
    for (const [key, config] of Object.entries(this.schema)) {
      const value = this.extractValue(key, config, parsed);

      // Only set if explicitly provided (not undefined)
      if (value !== undefined) {
        // Validate
        if (config.validate) {
          config.validate(value, this.runner);
        }

        this.values[key] = value;
      }
    }

    return this;
  }

  /**
   * Get parsed value with type safety
   * Returns the parsed value or the default if not set
   */
  get<T = unknown>(key: string): T {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generic return type for type-safe access by callers
    return (this.values[key] ?? this.schema[key]?.default) as T;
  }

  /**
   * Set value (for dependency arg overrides)
   */
  set(key: string, value: unknown): void {
    this.values[key] = value;
  }

  /**
   * Check if value was explicitly provided (not default)
   */
  isExplicit(key: string): boolean {
    return key in this.values;
  }

  /**
   * Get all arg configs for introspection
   */
  getSchema(): Record<string, ScriptArgConfig> {
    return { ...this.schema };
  }

  /**
   * Generate help text for all args
   */
  generateHelp(): string {
    const lines: string[] = [];

    for (const [key, config] of Object.entries(this.schema)) {
      if (config.hidden) continue;

      // Build flag names with aliases
      const flags: string[] = [`--${key}`];
      if (config.alias) {
        for (const alias of config.alias) {
          flags.push(alias.length === 1 ? `-${alias}` : `--${alias}`);
        }
      }

      // Build type indicator
      let typeIndicator = "";
      if (config.type === "string") {
        typeIndicator = " <value>";
      } else if (config.type === "number") {
        typeIndicator = " <number>";
      } else if (config.type === "string[]") {
        typeIndicator = " <value...>";
      }

      // Format line
      const flagsStr = flags.join(", ");
      const defaultStr =
        config.default !== undefined ? ` (default: ${config.default})` : "";
      lines.push(
        `  ${flagsStr}${typeIndicator}  ${config.description}${defaultStr}`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Build minimist options from schema
   */
  private buildMinimistOptions(): {
    boolean?: string[];
    string?: string[];
    alias?: Record<string, string | string[]>;
    default?: Record<string, unknown>;
  } {
    const booleanArgs: string[] = [];
    const stringArgs: string[] = [];
    const aliases: Record<string, string | string[]> = {};

    for (const [key, config] of Object.entries(this.schema)) {
      // Aliases - minimist expects alias -> key mapping (not key -> alias)
      if (config.alias && config.alias.length > 0) {
        for (const alias of config.alias) {
          aliases[alias] = key;
        }
      }

      // Type handling For minimist to properly parse aliases, we need to add BOTH the key and
      // all its aliases to the appropriate type array (string or boolean)
      const allNames = [key, ...(config.alias || [])];

      if (config.type === "boolean") {
        booleanArgs.push(...allNames);
      } else if (config.type === "string" || config.type === "number") {
        stringArgs.push(...allNames);
      }
      // Note: string[] is NOT added to stringArgs
      // This allows minimist to collect multiple values naturally

      // Defaults - don't pass defaults to minimist to avoid interference
      // We handle defaults in get() method instead
    }

    return {
      boolean: booleanArgs.length > 0 ? booleanArgs : undefined,
      string: stringArgs.length > 0 ? stringArgs : undefined,
      alias: Object.keys(aliases).length > 0 ? aliases : undefined,
      // Don't pass defaults to minimist
    };
  }

  /**
   * Extract value from parsed args based on config
   */
  private extractValue(
    key: string,
    config: ScriptArgConfig,
    parsed: ParsedArgs,
  ): unknown {
    const rawValue = parsed[key];

    if (rawValue === undefined) {
      return undefined; // Will use default in get()
    }

    // Type conversion
    if (config.type === "number") {
      const num = Number(rawValue);
      if (isNaN(num)) {
        throw new Error(`Invalid number for --${key}: ${rawValue}`);
      }
      return num;
    }

    if (config.type === "boolean") {
      return Boolean(rawValue);
    }

    if (config.type === "string[]") {
      // Ensure array
      return Array.isArray(rawValue) ? rawValue : [rawValue];
    }

    // string type
    return String(rawValue);
  }
}
