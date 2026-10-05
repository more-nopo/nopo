export default {
  test: {
    include: ["nopo/evaluations/decisions/smoke.test.ts"],
    testTimeout: 60000,
    maxWorkers: 1,
  },
};
