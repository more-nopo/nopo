# Test Suite for CLI Architecture

This test suite codifies the expected behavior documented in `@nopo/docs/cli/`. The tests are designed to fail in expected ways until the implementation is complete.

## Test Files

### `cli-routing.test.ts`

Tests the CLI entry point routing logic:

- **Help Commands**: Verifies recursive help behavior (`nopo build help`, `nopo --help`)
- **Script Class Routing**: Verifies known commands route to their script classes
- **Arbitrary Command Routing**: Verifies unknown commands route to `CommandScript` (not yet implemented)
- **Command Routing Priority**: Verifies script classes take precedence over arbitrary commands

**Expected Failures**:

- Recursive help tests fail because help detection for command-specific help is not implemented
- Arbitrary command routing tests fail because `CommandScript` doesn't exist yet

### `command.test.ts`

Tests the `CommandScript` class and command resolution:

- **CommandScript parseArgs**: Verifies argument parsing for commands
- **dependencies**: Verifies dependency resolution (EnvScript only for host, full deps for container)
- **execution**: Verifies command execution from nopo.yml
- **command resolution**: Verifies command resolution from nopo.yml configuration

**Status**: ✅ Most tests passing (CommandScript is implemented)

### `target-resolution.test.ts`

Tests target resolution algorithm:

- **parseTargetArgs for script classes**: Verifies target extraction from positionals
- **parseTargetArgs for arbitrary commands**: Verifies command name vs target separation
- **config loader**: Validates parsing of `nopo.yml` and service configs
- **target resolution behavior**: Verifies default behavior when no targets specified

**Status**: ✅ All tests passing (target resolution is already implemented)

### `dependency-resolution.test.ts`

Tests dependency resolution algorithm:

- **shared dependency resolution**: Verifies dependencies are resolved for script classes
- **dependency resolution for host execution**: Verifies only EnvScript for host
- **dependency resolution for container execution**: Verifies full dependencies for container
- **dependency execution order**: Verifies dependencies run before main command

**Status**: ✅ Most tests passing (dependency resolution is implemented, but uses static dependencies)

### `execution-modes.test.ts`

Tests execution mode behavior:

- **Host Execution**: Verifies `pnpm --filter` usage
- **Container Execution**: Verifies `docker compose run` usage
- **Execution Mode Detection**: Verifies `run` prefix detection

**Status**: ✅ All tests passing (as placeholders documenting expected behavior)

## Implementation Status

### ✅ Already Implemented

- Target resolution (`parseTargetArgs`, config-driven services)
- Dependency resolution (static dependencies)
- Script class routing (build, up, down, etc.)
- General help

### ⏳ Needs Implementation

1. **Recursive Help**: `nopo <command> help` should show command-specific help
2. **CLI Routing Updates**: Route unknown commands to `CommandScript`
3. **Instance Dependencies**: Dependencies should be instance properties, not static

## Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test cli-routing

# Watch mode
pnpm test:watch
```

## Test Philosophy

These tests follow a **test-driven development** approach:

1. Tests document the expected behavior from the architecture docs
2. Tests are written to fail in expected ways with current implementation
3. Implementation should make tests pass
4. Tests serve as living documentation of the system behavior

## Notes

- Some tests may timeout if Docker is not available (expected)
- Tests use temporary directories that are cleaned up automatically
- Mocking is used where appropriate to avoid external dependencies
- ANSI color codes in output are stripped for assertions
