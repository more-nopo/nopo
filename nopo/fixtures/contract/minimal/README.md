# contract/minimal

**Axis:** baseline / smoke test.

One service (`app`), no plugins, no runtimes map, no build deps, no runtime deps,
no commands beyond what the schema requires. Provides the bedrock for:

- happy-path smoke tests (`nopo list`, `nopo info app`, `nopo status`)
- `--print` reference output (no plugin overrides, no overlay merge)
- error-path tests that need a project root that loads cleanly so the failure
  is provably the test input, not the fixture
- target resolution sanity check ("only one node in the graph")
