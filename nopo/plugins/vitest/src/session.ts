import { fileURLToPath } from "node:url";
import type { ProcessChannel, SpawnResult } from "@more-nopo/nopo/io";
import type { HookContext } from "@more-nopo/nopo/plugin";
import type { ExecOptions, Runner } from "@more-nopo/nopo/lib";

interface Request {
  id: number;
  context: HookContext;
  options: ExecOptions;
  binary: string;
  args: string[];
  resolve(result: SpawnResult): void;
  reject(error: Error): void;
  stdout: string;
  stderr: string;
}
class VitestSession {
  private channel!: ProcessChannel;
  private sequence = 0;
  private queue: Request[] = [];
  private active?: Request;
  private ended = false;
  private draining = false;
  constructor(
    context: HookContext,
    private workers: number,
  ) {
    this.connect(context);
    context.runner.onDispose(() => this.close());
  }
  get closed(): boolean {
    return this.ended || this.draining;
  }
  private connect(context: HookContext) {
    this.ended = false;
    this.channel = context.io.openProcess!(
      "node",
      [fileURLToPath(new URL("./session-worker.mjs", import.meta.url))],
      {
        cwd: context.runner.config.root,
        onChunk: (chunk, source) => {
          const request = this.active;
          if (!request) return;
          const text = chunk.toString();
          request[source] += text;
          if (request.options.callback) request.options.callback(chunk, source);
          else if (!request.options.silent)
            request.context.io[source].write(text);
        },
      },
    );
    this.channel.onMessage((message) => {
      const response = message as {
        id?: number;
        exitCode?: number;
        error?: string;
        source?: "stdout" | "stderr";
        text?: string;
      };
      const request = this.active;
      if (!request || response.id !== request.id) return;
      if (response.source && typeof response.text === "string") {
        request[response.source] += response.text;
        if (request.options.callback)
          request.options.callback(Buffer.from(response.text), response.source);
        else if (!request.options.silent)
          request.context.io[response.source].write(response.text);
        return;
      }
      if (typeof response.exitCode !== "number") return;
      this.active = undefined;
      if (response.error) request.stderr += response.error + "\n";
      request.resolve({
        exitCode: response.exitCode,
        stdout: request.stdout,
        stderr: request.stderr,
      });
      this.dispatch();
    });
    const channel = this.channel;
    const exited = (error: Error) => {
      // A killed coordinator must not leave native workers behind.
      channel.kill("SIGKILL");
      if (this.channel !== channel) return;
      if (this.draining) {
        this.fail(error);
        return;
      }
      this.active?.reject(error);
      this.active = undefined;
      const next = this.queue[0];
      if (next) {
        this.connect(next.context);
        this.dispatch();
      } else this.ended = true;
    };
    void channel.closed.then(
      () => exited(new Error("[vitest] Shared coordinator exited")),
      exited,
    );
  }

  run(
    context: HookContext,
    binary: string,
    args: string[],
    options: ExecOptions,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    if (this.ended || this.draining)
      return Promise.reject(new Error("[vitest] Shared coordinator is closed"));
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("[vitest] Request aborted"));
        return;
      }
      const abort = () => {
        this.queue = this.queue.filter((item) => item.id !== request.id);
        if (this.active === request) this.channel.kill("SIGKILL");
        request.reject(new Error("[vitest] Request aborted"));
      };
      const request: Request = {
        id: ++this.sequence,
        context,
        binary,
        args,
        options,
        resolve: (result) => {
          signal?.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        stdout: "",
        stderr: "",
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(request);
      this.dispatch();
    });
  }
  private dispatch() {
    if (this.active || this.ended) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    const env = Object.fromEntries(
      Object.entries({
        ...request.context.io.env,
        ...request.options.env,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    void this.channel
      .send({
        id: request.id,
        binary: request.binary,
        args: request.args,
        cwd: request.options.cwd ?? request.context.runner.config.root,
        env,
        workers: this.workers,
      })
      .catch(() => this.channel.kill("SIGKILL"));
  }
  private fail(error: Error) {
    this.ended = true;
    this.active?.reject(error);
    this.active = undefined;
    for (const request of this.queue.splice(0)) request.reject(error);
  }
  async close() {
    if (this.ended) return;
    this.draining = true;
    const timer = setTimeout(() => this.channel.kill("SIGKILL"), 3000);
    try {
      await this.channel
        .send({ method: "close" })
        .catch(() => this.channel.kill());
      await this.channel.closed;
    } finally {
      clearTimeout(timer);
      this.fail(new Error("[vitest] Shared coordinator closed"));
    }
  }
}
const sessions = new WeakMap<Runner, VitestSession>();
const settings = new WeakMap<
  HookContext,
  { execution?: "shared" | "isolated"; workers?: number }
>();
export function configureSession(
  context: HookContext,
  options: { execution?: "shared" | "isolated"; workers?: number },
) {
  settings.set(context, options);
}

export async function runVitestProcess(
  context: HookContext,
  argv: string[],
  options: ExecOptions = {},
  signal?: AbortSignal,
): Promise<SpawnResult> {
  const configured = settings.get(context);
  const pooled =
    configured?.execution !== "isolated" &&
    context.io.openProcess &&
    !argv.some((arg) =>
      ["--help", "-h", "--version", "--watch", "--ui"].includes(arg),
    ) &&
    (argv[1] !== "list" ||
      (argv.includes("--filesOnly") &&
        argv.some((arg) => arg === "--json" || arg.startsWith("--json="))));
  if (!pooled) {
    const result = signal
      ? await context.io.spawn("node", argv, {
          cwd: options.cwd,
          env: options.env
            ? Object.fromEntries(
                Object.entries(options.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              )
            : undefined,
          signal,
        })
      : await context.exec("node", argv, options);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  let session = sessions.get(context.runner);
  if (!session || session.closed) {
    session = new VitestSession(context, configured?.workers ?? 2);
    sessions.set(context.runner, session);
  }
  const result = await session.run(
    context,
    argv[0]!,
    argv.slice(1),
    options,
    signal,
  );
  if (result.exitCode && !options.nothrow)
    throw Object.assign(
      new Error(
        `[vitest] Tests failed (exit ${result.exitCode})${result.stderr ? ": " + result.stderr : ""}`,
      ),
      result,
    );
  return result;
}
