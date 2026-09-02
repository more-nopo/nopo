/** `os.availableParallelism()` reports the host's logical CPU count — it does NOT respect a
 * cgroup CPU quota. Inside a container/pod (e.g. our CI runner, limited to 2.5 cores on a
 * many-core node) it returns the node's full core count, so the plan runner fans out far
 * past what the cgroup actually grants. For memory-heavy fan-out
 */

import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";

/** Default per-worker memory budget used to derive the memory-bound cap. */
export const DEFAULT_MEM_PER_WORKER_MB = 1024;

/** Fraction of host physical memory we'll budget for worker fan-out when no cgroup memory
 * limit applies. The rest is headroom for the OS, the user's editor/browser, Docker
 * Desktop, and the services under test — the analog of the queue reserving a couple of CPU
 * cores so the laptop stays responsive.
 */
export const HOST_MEM_USABLE_FRACTION = 0.75;

/**
 * Injection seam for tests. The default probe reads the real cgroup files,
 * host CPU/memory, and `process.env`; tests pass a fake to make detection
 * deterministic without touching the filesystem.
 */
export interface ResourceProbe {
  /** Returns the file's contents, or `undefined` if it can't be read. */
  readFile(path: string): string | undefined;
  /** Host logical CPU count (`os.availableParallelism()`). */
  hostCpus(): number;
  /** Host physical memory in bytes (`os.totalmem()`). */
  hostMemBytes(): number;
  /** Reads an environment variable. */
  env(name: string): string | undefined;
}

export const defaultProbe: ResourceProbe = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  hostCpus: () => availableParallelism(),
  hostMemBytes: () => totalmem(),
  env: (name) => process.env[name],
};

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Effective CPU quota in (possibly fractional) cores, or `undefined` when no
 * quota is set (unlimited) and the host count should be used instead. Tries
 * cgroup v2 (`cpu.max`) then v1 (`cpu.cfs_quota_us` / `cpu.cfs_period_us`).
 */
export function cgroupCpuLimit(
  probe: ResourceProbe = defaultProbe,
): number | undefined {
  // cgroup v2: "<quota> <period>" in microseconds, or "max <period>".
  const v2 = probe.readFile("/sys/fs/cgroup/cpu.max");
  if (v2 !== undefined) {
    const [quota, period] = v2.trim().split(/\s+/);
    if (quota === "max") return undefined;
    const q = Number(quota);
    const p = Number(period);
    if (Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0) {
      return q / p;
    }
    return undefined;
  }

  // cgroup v1: quota of -1 means unlimited.
  const quotaRaw = probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const periodRaw = probe.readFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  if (quotaRaw !== undefined && periodRaw !== undefined) {
    const q = Number(quotaRaw.trim());
    const p = Number(periodRaw.trim());
    if (Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0) {
      return q / p;
    }
  }
  return undefined;
}

/** Effective memory limit in bytes, or `undefined` when the cgroup imposes no limit tighter
 * than physical RAM (a limit ≥ host RAM offers no protection, so we ignore it and treat
 * memory as unbounded). Tries cgroup v2 (`memory.max`) then v1 (`memory.limit_in_bytes`).
 */
export function cgroupMemoryLimit(
  probe: ResourceProbe = defaultProbe,
): number | undefined {
  const hostMem = probe.hostMemBytes();

  const raw =
    probe.readFile("/sys/fs/cgroup/memory.max") ??
    probe.readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "max") return undefined;
  const bytes = Number(trimmed);
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;

  // A limit at or above physical RAM (incl. the v1 "unlimited" sentinel,
  // which is ~2^63) is not a real constraint — ignore it.
  if (bytes >= hostMem) return undefined;
  return bytes;
}

/** Effective memory budget in bytes available for worker fan-out: the cgroup `memory.max`
 * when one tighter than host RAM applies (CI/container), otherwise a fraction of host
 * physical memory ({@link HOST_MEM_USABLE_FRACTION}). Unlike {@link cgroupMemoryLimit},
 * this is never `undefined` — memory is bounded on every host, including macOS, where
 */
export function effectiveMemoryBudget(
  probe: ResourceProbe = defaultProbe,
): number {
  const cgroupLimit = cgroupMemoryLimit(probe);
  if (cgroupLimit !== undefined) return cgroupLimit;
  return Math.floor(probe.hostMemBytes() * HOST_MEM_USABLE_FRACTION);
}

/** The memory-bound concurrency cap: how many workers fit in the effective memory budget at
 * the per-worker budget. The per-worker budget defaults to {@link
 * DEFAULT_MEM_PER_WORKER_MB} and is tunable with `NOPO_MEM_PER_WORKER_MB` — on a
 * memory-heavy laptop, raise it to match real `tsc`/`eslint`/`vitest` heaps
 */
export function memoryConcurrencyCap(
  probe: ResourceProbe = defaultProbe,
): number {
  const perWorkerMb =
    parsePositiveInt(probe.env("NOPO_MEM_PER_WORKER_MB")) ??
    DEFAULT_MEM_PER_WORKER_MB;
  const perWorkerBytes = perWorkerMb * 1024 * 1024;
  return Math.max(1, Math.floor(effectiveMemoryBudget(probe) / perWorkerBytes));
}

/** The auto-detected concurrency cap: the most parallel work we can safely run without
 * exceeding the CPU quota or the memory budget the process runs under. 1.
 * `NOPO_CONCURRENCY` — explicit hard override; detection is skipped. 2. `min(cpuCap,
 * memCap)` where `cpuCap` = floor(cgroup CPU quota) or host CPU count, `memCap` =
 */
export function autoConcurrency(probe: ResourceProbe = defaultProbe): number {
  const override = parsePositiveInt(probe.env("NOPO_CONCURRENCY"));
  if (override !== undefined) return override;

  const cpuQuota = cgroupCpuLimit(probe);
  const cpuCap =
    cpuQuota !== undefined
      ? Math.max(1, Math.floor(cpuQuota))
      : Math.max(1, probe.hostCpus());

  return Math.max(1, Math.min(cpuCap, memoryConcurrencyCap(probe)));
}
