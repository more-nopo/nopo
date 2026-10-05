/** Node-only coordinator. Nopo owns its lifetime through a tracked IPC channel. */
import { writeFileSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

let instance;
let signature;
let runOutcome;
let configFiles = [];
let configStamp;
function stamp() {
  return configFiles
    .map((file) => {
      try {
        const info = statSync(file);
        return `${file}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join("\n");
}
let shuttingDown = false;
let queue = Promise.resolve();
const originalEnv = { ...process.env };
let activeId;
for (const [stream, source] of [
  [process.stdout, "stdout"],
  [process.stderr, "stderr"],
]) {
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    if (activeId === undefined) return original(chunk, encoding, callback);
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
      : String(chunk);
    process.send?.({ id: activeId, source, text });
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
}
function describeError(error) {
  return [
    error instanceof Error ? error.message : String(error),
    ...(Array.isArray(error?.errors) ? error.errors.map(describeError) : []),
  ].join("\n");
}

async function close() {
  if (instance) {
    const previous = instance;
    instance = undefined;
    signature = undefined;
    await previous.close();
  }
}
async function handle(request) {
  if (shuttingDown) return;
  activeId = request.id;
  try {
    const api = await import(
      new URL("./dist/node.js", pathToFileURL(request.binary)).href
    );
    const parsed = api.parseCLI(["vitest", ...request.args]);
    // Match native CLI normalization: --exclude appends, never replaces config excludes.
    if (parsed.options.exclude) {
      parsed.options.cliExclude = Array.isArray(parsed.options.exclude)
        ? parsed.options.exclude
        : [parsed.options.exclude];
      delete parsed.options.exclude;
    }
    const requestedWorkers = parsed.options.maxWorkers;
    if (
      requestedWorkers !== undefined &&
      !/^\d+(?:%|\.\d+%)?$/.test(String(requestedWorkers))
    )
      throw new Error("Invalid Vitest maxWorkers");
    if (
      requestedWorkers !== undefined &&
      parseFloat(String(requestedWorkers)) <= 0
    )
      throw new Error("Vitest maxWorkers must be positive");
    const options = {
      ...parsed.options,
      root: realpathSync(request.cwd),
      watch: false,
    };
    if (parsed.options.watch || parsed.options.ui || parsed.options.standalone)
      throw new Error(
        "Interactive Vitest options require plugins.vitest.execution: isolated",
      );
    const nextSignature = JSON.stringify({
      binary: request.binary,
      cwd: request.cwd,
      env: request.env,
      options,
    });
    if (signature !== nextSignature || configStamp !== stamp()) {
      await close();
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, originalEnv, request.env);
      process.chdir(request.cwd);
      const major = Number(api.version.split(".")[0]);
      instance =
        major >= 5
          ? await api.createVitest(options)
          : await api.createVitest("test", options);
      // Native end events contain only this run, unlike the cumulative state/result APIs.
      instance.reporters.push({
        onTestRunEnd(modules, errors, state) {
          runOutcome = { modules, errors, state };
        },
      });
      // Apply the invocation budget after native config resolution, preserving lower limits.
      for (const config of [
        instance.config,
        ...instance.projects.map((project) => project.config),
      ]) {
        config.maxWorkers = Math.min(
          config.maxWorkers ?? request.workers,
          request.workers,
        );
        if (config.minWorkers !== undefined)
          config.minWorkers = Math.min(config.minWorkers, config.maxWorkers);
        for (const pool of Object.values(config.poolOptions ?? {})) {
          if (!pool || typeof pool !== "object") continue;
          for (const key of [
            "maxForks",
            "maxThreads",
            "minForks",
            "minThreads",
          ]) {
            if (typeof pool[key] === "number")
              pool[key] = Math.min(pool[key], config.maxWorkers);
          }
        }
      }
      configFiles = [
        ...new Set(
          [instance.vite, ...instance.projects.map((project) => project.vite)]
            .flatMap((vite) => [
              vite.config.configFile,
              ...(vite.config.configFileDependencies ?? []),
            ])
            .filter(Boolean),
        ),
      ];
      configStamp = stamp();
      signature = nextSignature;
    } else {
      // Native one-shot calls see current files even when an intervening DAG task generated source.
      instance.vite.moduleGraph.invalidateAll();
      for (const project of instance.projects)
        project.vite.moduleGraph.invalidateAll();
      instance.clearSpecificationsCache();
    }
    process.exitCode = 0;
    runOutcome = undefined;
    let exitCode = 0;
    if (request.args[0] === "list") {
      const specifications = await instance.getRelevantTestSpecifications(
        parsed.filter,
      );
      const rows = specifications.map((spec) => ({
        file: spec.moduleId,
        projectName: spec.project.name,
      }));
      const json = request.args
        .find((arg) => arg.startsWith("--json="))
        ?.slice(7);
      const content = JSON.stringify(rows);
      if (json) writeFileSync(json, content);
      else process.stdout.write(content + "\n");
    } else {
      // start() initializes reporters/coverage and applies native filters, shard and empty-suite semantics.
      await instance.start(parsed.filter);
      if (
        runOutcome?.modules.some((module) => !module.ok()) ||
        runOutcome?.errors.length ||
        runOutcome?.state === "failed"
      )
        exitCode = 1;
      exitCode ||= Number(process.exitCode) || 0;
    }
    process.exitCode = 0;
    // Vitest consumes related/changed selectors; recreate before their next request.
    if (parsed.options.changed || parsed.options.related) await close();
    process.send?.({ id: request.id, exitCode });
  } catch (error) {
    process.exitCode = 0;
    const empty =
      error?.code === "VITEST_FILES_NOT_FOUND" &&
      instance?.config.passWithNoTests;
    await close().catch(() => {});
    process.send?.({
      id: request.id,
      exitCode: empty ? 0 : 1,
      ...(empty ? {} : { error: describeError(error) }),
    });
  } finally {
    activeId = undefined;
  }
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await close().catch(() => {});
  process.disconnect?.();
}
process.on("message", (request) => {
  if (request.method === "close") {
    void queue.then(shutdown);
    return;
  }
  queue = queue.then(() => handle(request));
});
process.once("disconnect", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
