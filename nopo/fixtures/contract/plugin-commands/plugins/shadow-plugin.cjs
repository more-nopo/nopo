/* eslint-disable no-undef */
// Test plugin "shadow-plugin" — second plugin used by the M4.8 contract
// tests to observe registration ordering and additive-hook firing order.

module.exports.default = function shadowPlugin() {
  return {
    name: "shadow-plugin",
    description: "M4.8 contract fixture: secondary plugin",

    hooks: {
      pre_build: async function (ctx) {
        ctx.runner.io.stdout.write("shadow-plugin:pre_build\n");
      },
    },

    commands: [
      {
        name: "noop",
        description: "Does nothing — exists so the plugin appears in help.",
        fn: async function () {
          // Intentionally empty.
        },
      },
    ],
  };
};
