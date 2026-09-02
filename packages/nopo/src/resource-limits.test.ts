import { describe, expect, it } from "vitest";

import {
  autoConcurrency,
  cgroupCpuLimit,
  cgroupMemoryLimit,
  effectiveMemoryBudget,
  HOST_MEM_USABLE_FRACTION,
  memoryConcurrencyCap,
  type ResourceProbe,
} from "./resource-limits.ts";

const GiB = 1024 * 1024 * 1024;

/** Builds a fake probe; unspecified files read as undefined. */
function probe(opts: {
  files?: Record<string, string>;
  hostCpus?: number;
  hostMemBytes?: number;
  env?: Record<string, string>;
}): ResourceProbe {
  return {
    readFile: (path) => opts.files?.[path],
    hostCpus: () => opts.hostCpus ?? 8,
    hostMemBytes: () => opts.hostMemBytes ?? 16 * GiB,
    env: (name) => opts.env?.[name],
  };
}

describe("cgroupCpuLimit", () => {
  it("reads a cgroup v2 quota (cpu.max)", () => {
    const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "250000 100000" } });
    expect(cgroupCpuLimit(p)).toBeCloseTo(2.5);
  });

  it("treats v2 'max' as unlimited (undefined)", () => {
    const p = probe({ files: { "/sys/fs/cgroup/cpu.max": "max 100000" } });
    expect(cgroupCpuLimit(p)).toBeUndefined();
  });

  it("reads a cgroup v1 quota/period", () => {
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      },
    });
    expect(cgroupCpuLimit(p)).toBeCloseTo(2);
  });

  it("treats a v1 quota of -1 as unlimited", () => {
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
      },
    });
    expect(cgroupCpuLimit(p)).toBeUndefined();
  });

  it("returns undefined when no cgroup files are present (off-Linux)", () => {
    expect(cgroupCpuLimit(probe({}))).toBeUndefined();
  });
});

describe("cgroupMemoryLimit", () => {
  it("reads a cgroup v2 memory.max below host RAM", () => {
    const p = probe({
      files: { "/sys/fs/cgroup/memory.max": String(8 * GiB) },
      hostMemBytes: 64 * GiB,
    });
    expect(cgroupMemoryLimit(p)).toBe(8 * GiB);
  });

  it("ignores a limit at or above host RAM (no real constraint)", () => {
    const p = probe({
      files: { "/sys/fs/cgroup/memory.max": String(64 * GiB) },
      hostMemBytes: 64 * GiB,
    });
    expect(cgroupMemoryLimit(p)).toBeUndefined();
  });

  it("ignores the v1 'unlimited' sentinel", () => {
    const p = probe({
      files: {
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
      },
      hostMemBytes: 64 * GiB,
    });
    expect(cgroupMemoryLimit(p)).toBeUndefined();
  });
});

describe("effectiveMemoryBudget", () => {
  it("uses the cgroup memory.max when one applies", () => {
    const p = probe({
      files: { "/sys/fs/cgroup/memory.max": String(8 * GiB) },
      hostMemBytes: 64 * GiB,
    });
    expect(effectiveMemoryBudget(p)).toBe(8 * GiB);
  });

  it("falls back to a fraction of host RAM off-Linux (no cgroup)", () => {
    const p = probe({ hostMemBytes: 16 * GiB });
    expect(effectiveMemoryBudget(p)).toBe(
      Math.floor(16 * GiB * HOST_MEM_USABLE_FRACTION),
    );
  });

  it("falls back to host RAM when the cgroup limit is not a real constraint", () => {
    // memory.max >= host RAM → cgroupMemoryLimit ignores it → host fallback.
    const p = probe({
      files: { "/sys/fs/cgroup/memory.max": String(64 * GiB) },
      hostMemBytes: 64 * GiB,
    });
    expect(effectiveMemoryBudget(p)).toBe(
      Math.floor(64 * GiB * HOST_MEM_USABLE_FRACTION),
    );
  });
});

describe("memoryConcurrencyCap", () => {
  it("sizes from host RAM off-Linux (12Gi usable @ 1Gi/worker -> 12)", () => {
    const p = probe({ hostMemBytes: 16 * GiB }); // 0.75 * 16 = 12
    expect(memoryConcurrencyCap(p)).toBe(12);
  });

  it("respects NOPO_MEM_PER_WORKER_MB off-Linux (12Gi @ 2Gi/worker -> 6)", () => {
    const p = probe({
      hostMemBytes: 16 * GiB,
      env: { NOPO_MEM_PER_WORKER_MB: "2048" },
    });
    expect(memoryConcurrencyCap(p)).toBe(6);
  });

  it("never returns less than 1", () => {
    const p = probe({ hostMemBytes: GiB }); // 0.75Gi usable @ 1Gi/worker
    expect(memoryConcurrencyCap(p)).toBe(1);
  });
});

describe("autoConcurrency", () => {
  it("honors NOPO_CONCURRENCY as a hard override, skipping detection", () => {
    const p = probe({
      files: { "/sys/fs/cgroup/cpu.max": "100000 100000" }, // would cap at 1
      env: { NOPO_CONCURRENCY: "12" },
    });
    expect(autoConcurrency(p)).toBe(12);
  });

  it("ignores a non-positive / garbage NOPO_CONCURRENCY", () => {
    const p = probe({ hostCpus: 6, env: { NOPO_CONCURRENCY: "0" } });
    expect(autoConcurrency(p)).toBe(6);
  });

  it("falls back to host CPUs off-Linux with no cgroup", () => {
    expect(autoConcurrency(probe({ hostCpus: 10 }))).toBe(10);
  });

  it("floors a fractional CPU quota (2.5 cores -> 2)", () => {
    const p = probe({
      files: { "/sys/fs/cgroup/cpu.max": "250000 100000" },
      hostCpus: 16,
      hostMemBytes: 64 * GiB,
    });
    expect(autoConcurrency(p)).toBe(2);
  });

  it("matches the CI runner pod profile (2.5 cpu / 8Gi -> 2)", () => {
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu.max": "250000 100000",
        "/sys/fs/cgroup/memory.max": String(8 * GiB),
      },
      hostCpus: 16,
      hostMemBytes: 64 * GiB,
    });
    expect(autoConcurrency(p)).toBe(2);
  });

  it("lets memory be the binding constraint when tighter than CPU", () => {
    // 8 cores granted, but only 3Gi @ 1Gi/worker -> 3.
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu.max": "800000 100000",
        "/sys/fs/cgroup/memory.max": String(3 * GiB),
      },
      hostMemBytes: 64 * GiB,
    });
    expect(autoConcurrency(p)).toBe(3);
  });

  it("respects NOPO_MEM_PER_WORKER_MB when sizing the memory cap", () => {
    // 8Gi @ 2Gi/worker -> 4 (vs CPU cap of 8).
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu.max": "800000 100000",
        "/sys/fs/cgroup/memory.max": String(8 * GiB),
      },
      hostMemBytes: 64 * GiB,
      env: { NOPO_MEM_PER_WORKER_MB: "2048" },
    });
    expect(autoConcurrency(p)).toBe(4);
  });

  it("lets host memory bind off-Linux when RAM is the scarce resource", () => {
    // macOS profile: no cgroup at all. 10 cores, but only 8Gi RAM and a 2Gi
    // per-worker heap → 0.75*8/2 = 3 workers. Memory wins, not cores.
    const p = probe({
      hostCpus: 10,
      hostMemBytes: 8 * GiB,
      env: { NOPO_MEM_PER_WORKER_MB: "2048" },
    });
    expect(autoConcurrency(p)).toBe(3);
  });

  it("never returns less than 1", () => {
    const p = probe({
      files: {
        "/sys/fs/cgroup/cpu.max": "50000 100000", // 0.5 cores
        "/sys/fs/cgroup/memory.max": String(GiB / 2), // 0.5Gi
      },
      hostMemBytes: 64 * GiB,
    });
    expect(autoConcurrency(p)).toBe(1);
  });
});
