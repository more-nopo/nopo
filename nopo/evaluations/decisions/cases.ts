export interface Scenario {
  name: string;
  initial: Record<string, string>;
  changedFile: string;
  replacement: string;
  tests: Record<string, { body: string; expected: string[] }>;
  relevant: string[];
  unrelated: string[];
  expectedFailures: string[];
  cohorts?: { name: string; files: string[]; mockRange: [number, number] }[];
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

function gradedScenario(): Scenario {
  const initial: Record<string, string> = {
    "apps/demo/src/money.ts":
      "export const cents=(amount:number)=>Math.round(amount*100);\n",
    "apps/demo/src/checkout.ts":
      "import {cents} from './money'; export const checkout=(amount:number)=>cents(amount); export const label='checkout';\n",
    "apps/demo/src/invoice.ts":
      "import {checkout} from './checkout'; export const invoice=(amount:number)=>checkout(amount);\n",
    "apps/demo/src/report.ts":
      "import {invoice} from './invoice'; export const report=(amount:number)=>invoice(amount);\n",
    "apps/demo/src/aggregate.ts":
      "import {report} from './report'; export const aggregate=(amount:number)=>report(amount)+1000000;\n",
    "apps/demo/src/optional.ts":
      "import {checkout} from './checkout'; export const optional=(amount:number,enabled:boolean)=>enabled?checkout(amount):0;\n",
    "apps/demo/src/format.ts":
      "export const format=(value:string)=>'$'+value;\n",
    "apps/demo/src/auth.ts":
      "export const valid=(value:string)=>value.length>8;\n",
  };
  const definitions = [
    {
      name: "direct-value",
      body: "import {cents} from './src/money';",
      expression: (x: string) => `cents(${x})`,
      expected: (n: number) => String(n),
      fails: true,
      range: [0.99, 0.96],
    },
    {
      name: "immediate-wrapper",
      body: "import {checkout} from './src/checkout';",
      expression: (x: string) => `checkout(${x})`,
      expected: (n: number) => String(n),
      fails: true,
      range: [0.95, 0.88],
    },
    {
      name: "deep-wrapper",
      body: "import {report} from './src/report';",
      expression: (x: string) => `report(${x})`,
      expected: (n: number) => String(n),
      fails: true,
      range: [0.87, 0.8],
    },
    {
      name: "mixed-aggregate",
      body: "import {aggregate} from './src/aggregate';",
      expression: (x: string) => `aggregate(${x})`,
      expected: (n: number) => String(1000000 + n),
      fails: true,
      range: [0.79, 0.66],
    },
    {
      name: "conditional-enabled",
      body: "import {optional} from './src/optional';",
      expression: (x: string) => `optional(${x},true)`,
      expected: (n: number) => String(n),
      fails: true,
      range: [0.65, 0.55],
    },
    {
      name: "conditional-bypass",
      body: "import {optional} from './src/optional';",
      expression: (x: string) => `optional(${x},false)`,
      expected: () => "0",
      fails: false,
      range: [0.49, 0.36],
    },
    {
      name: "invariant-overlap",
      body: "import {checkout} from './src/checkout';",
      expression: (x: string) => `checkout(${x})>0`,
      expected: () => "true",
      fails: false,
      range: [0.35, 0.22],
    },
    {
      name: "unaffected-export",
      body: "import {label} from './src/checkout';",
      expression: () => "label",
      expected: () => "'checkout'",
      fails: false,
      range: [0.21, 0.12],
    },
    {
      name: "keyword-decoy",
      body: "import {format} from './src/format';",
      expression: () => "format('money cents checkout')",
      expected: () => "'$money cents checkout'",
      fails: false,
      range: [0.11, 0.04],
    },
    {
      name: "unrelated-auth",
      body: "import {valid} from './src/auth';",
      expression: () => "valid('long-password')",
      expected: () => "true",
      fails: false,
      range: [0.03, 0.01],
    },
  ];
  const tests: Scenario["tests"] = {},
    relevant: string[] = [],
    unrelated: string[] = [],
    expectedFailures: string[] = [];
  const cohorts: NonNullable<Scenario["cohorts"]> = [];
  for (const [group, definition] of definitions.entries()) {
    const files: string[] = [];
    for (let variant = 0; variant < 10; variant++) {
      // Interleave cohorts across alphabetically sorted API batches; names do not reveal expected scores.
      const file = `case-${String(variant * 10 + group).padStart(3, "0")}.test.ts`;
      files.push(file);
      const amount = (1.125 + variant / 4).toFixed(3),
        rounded = Math.round(Number(amount) * 100);
      tests[file] = {
        body: definition.body,
        expected: [definition.expression(amount), definition.expected(rounded)],
      };
      if (definition.fails) {
        relevant.push(file);
        expectedFailures.push(file);
      } else if (group >= 8) unrelated.push(file);
    }
    cohorts.push({
      name: definition.name,
      files,
      mockRange: definition.range as [number, number],
    });
  }
  return {
    name: "graded-middle-module-100",
    initial,
    changedFile: "apps/demo/src/money.ts",
    replacement:
      "export const cents=(amount:number)=>Math.floor(amount*100);\n",
    tests,
    relevant,
    unrelated,
    expectedFailures,
    cohorts,
  };
}
scenarios.push(gradedScenario());
