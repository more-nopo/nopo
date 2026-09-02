/* eslint-disable no-undef */
/** M4.8 contract fixture: smallest commands for stdout, ctx.shell, throw→exit 1,
 * positionals, hook order. CJS so `dynamic import()` loads without the test TS
 * pipeline; no workspace `@more-nopo/nopo-plugin-*` (not pre-built — see all-plugins).
 */

module.exports.default = function cliPlugin() {
  return {
    name: "cli-plugin",
    description: "M4.8 contract fixture: plugin command surface",

    /** pre_build is an additive hook; firing order is plugin-declaration
     * order. Used by tests asserting hook-execution ordering when paired
     * with shadow-plugin.
     */
    hooks: {
      pre_build: async function (ctx) {
        ctx.runner.io.stdout.write("cli-plugin:pre_build\n");
      },
    },

    commands: [
      {
        name: "hello",
        description: "Plain command — writes a literal string to stdout.",
        fn: async function (ctx) {
          ctx.runner.io.stdout.write("cli-plugin:hello\n");
        },
      },
      {
        name: "print-args",
        description: "Echoes parsed --who flag and positionals to stdout.",
        /** No `args` schema — relies on the empty-schema default in
         * runPluginCommand. Tests that assert positional capture exercise
         * this path.
         */
        fn: async function (ctx) {
          const positionals = ctx.positionals || [];
          ctx.runner.io.stdout.write(
            JSON.stringify({ positionals: positionals }) + "\n",
          );
        },
      },
      {
        name: "shell",
        description: "Spawns a subprocess via ctx.shell — captured by MockIO.",
        fn: async function (ctx) {
          // ctx.shell routes through ctx.io.spawn (MockIO captures cmd+args).
          await ctx.shell()`echo plugin-cmd-shelled`;
        },
      },
      {
        name: "boom",
        description: "Throws — driver should log and exit 1.",
        fn: async function () {
          throw new Error("cli-plugin:boom intentional failure");
        },
      },
    ],
  };
};
