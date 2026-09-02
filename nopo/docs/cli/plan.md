# CLI Architecture Plan

This document outlines the desired CLI behavior. See the detailed documentation:

- [Architecture Documentation](./architecture.md) - Complete system architecture with diagrams
- [Quick Reference](./quick-reference.md) - Common usage patterns
- [Arbitrary Commands](./commands/arbitrary.md) - Detailed guide for arbitrary command execution
- [Main Documentation](./index.md) - Complete CLI documentation

## Core Requirements

1. **Help**: 
   - Running the CLI with no arguments or `help` prints general help
   - `nopo <command> help` or `nopo <command> --help` prints command-specific help (recursive help)
2. **Script Class Routing**: Check first argument to see if it matches a known script class (build, status, up, etc.) - if so, resolve dependencies and execute
3. **Arbitrary Command Routing**: If not a script class, treat as arbitrary pnpm script command

## Command Examples

### Help
```
nopo                    # General help
nopo help               # General help
nopo build help         # Help for build command (recursive)
nopo build --help       # Help for build command (recursive)
nopo up help            # Help for up command (recursive)
```

### Script Classes
```
nopo build 
nopo build backend web
nopo build backend web --no-cache
```

### Arbitrary Commands - Host Execution
```
nopo lint                    # Run lint on all targets (or root)
nopo lint web               # Run lint package.json command on the web target
nopo test backend           # Run test on backend target
```

### Arbitrary Commands - Container Execution
```
nopo run lint web           # Run lint in container (runs in a container because of 'run')
nopo run test backend       # Run test in container
```

## Key Principles

1. **Shared Algorithms**: Both script classes and arbitrary commands use the same:
   - Target resolver algorithm
   - Dependency resolver algorithm

2. **Execution Modes**:
   - **Host**: `nopo lint web` - runs on host using `pnpm --filter`
   - **Container**: `nopo run lint web` - runs in container using `docker compose run`

3. **Dependency Resolution**:
   - Host execution: Only `EnvScript` (environment variables)
   - Container execution: Full dependencies (env, build, pull if needed)

## Implementation Status

✅ **Documentation Complete**: Architecture, usage patterns, and examples are documented
⏳ **Implementation Pending**: Code changes to implement the documented behavior

See [Architecture Documentation](./architecture.md) for implementation details and flow diagrams.

