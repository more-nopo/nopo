export interface Scenario {
  name: string;
  initial: Record<string, string>;
  changedFile: string;
  replacement: string;
  tests: Record<string, { body: string; expected: string[] }>;
  relevant: string[];
  unrelated: string[];
  expectedFailures: string[];
}
export const scenarios: Scenario[] = [
  {
    name: "shared-test-harness-regression",
    initial: {
      "apps/demo/harness.ts":
        "export const verify = (actual: unknown, expected: unknown) => actual === expected;\n",
    },
    changedFile: "apps/demo/harness.ts",
    replacement:
      "export const verify = (actual: unknown, expected: unknown) => actual !== expected;\n",
    tests: {
      "checkout.test.ts": {
        body: "import {verify} from './harness';",
        expected: ["verify(120, 120)", "true"],
      },
      "login.test.ts": {
        body: "import {verify} from './harness';",
        expected: ["verify('valid', 'valid')", "true"],
      },
      "label.test.ts": {
        body: "import {verify} from './harness';",
        expected: ["verify('VAT', 'VAT')", "true"],
      },
    },
    relevant: ["checkout.test.ts", "login.test.ts", "label.test.ts"],
    unrelated: [],
    expectedFailures: ["checkout.test.ts", "login.test.ts", "label.test.ts"],
  },
  {
    name: "tax-regression-with-keyword-decoy",
    initial: {
      "apps/demo/src/tax.ts":
        "export const total = (amount: number) => amount * 1.20;\n",
    },
    changedFile: "apps/demo/src/tax.ts",
    replacement: "export const total = (amount: number) => amount * 1.02;\n",
    tests: {
      "checkout.test.ts": {
        body: "import {total} from './src/tax';",
        expected: ["total(100)", "120"],
      },
      "tax-label.test.ts": {
        body: "const taxLabel = (name: string) => 'Tax: ' + name;",
        expected: ["taxLabel('VAT')", "'Tax: VAT'"],
      },
      "login.test.ts": {
        body: "const valid = (password: string) => password.length >= 8;",
        expected: ["valid('abcdefgh')", "true"],
      },
    },
    relevant: ["checkout.test.ts"],
    unrelated: ["tax-label.test.ts", "login.test.ts"],
    expectedFailures: ["checkout.test.ts"],
  },
  {
    name: "shared-dependency-rounding-regression",
    initial: {
      "packages/money/src/index.ts":
        "export const cents = (amount: number) => Math.round(amount * 100);\n",
    },
    changedFile: "packages/money/src/index.ts",
    replacement:
      "export const cents = (amount: number) => Math.floor(amount * 100);\n",
    tests: {
      "invoice.test.ts": {
        body: "import {cents} from '../../packages/money/src';",
        expected: ["cents(1.235)", "124"],
      },
      "ledger.test.ts": {
        body: "import {cents} from '../../packages/money/src';",
        expected: ["cents(4.567)", "457"],
      },
      "auth.test.ts": {
        body: "const auth = (token: string) => token === 'valid';",
        expected: ["auth('valid')", "true"],
      },
    },
    relevant: ["invoice.test.ts", "ledger.test.ts"],
    unrelated: ["auth.test.ts"],
    expectedFailures: ["invoice.test.ts", "ledger.test.ts"],
  },
  {
    name: "documentation-only-control",
    initial: {
      "README.md": "# Login and tax modules\nLocal developer guide.\n",
      "apps/demo/src/tax.ts":
        "export const total = (amount: number) => amount * 1.20;\n",
    },
    changedFile: "README.md",
    replacement:
      "# Login and tax modules\nUpdated local developer guide punctuation.\n",
    tests: {
      "checkout.test.ts": {
        body: "import {total} from './src/tax';",
        expected: ["total(100)", "120"],
      },
      "tax-label.test.ts": {
        body: "const taxLabel = (name: string) => 'Tax: ' + name;",
        expected: ["taxLabel('VAT')", "'Tax: VAT'"],
      },
      "login.test.ts": {
        body: "const valid = (password: string) => password.length >= 8;",
        expected: ["valid('abcdefgh')", "true"],
      },
    },
    relevant: [],
    unrelated: ["checkout.test.ts", "tax-label.test.ts", "login.test.ts"],
    expectedFailures: [],
  },
];
