export default {
  test: {
    include: ["nopo/evaluations/decisions/*.test.ts"],
    testTimeout: 60000,
    maxWorkers: 1,
  },
};
