# Medium Priority: Type Safety in Debug UI

## Issue
The OrchestratorDebugUI component uses multiple `any` types to handle dynamic inquirer choices and separators. This reduces type safety and could lead to runtime errors.

## Location
- `src/commands/debug/orchestrator/OrchestratorDebugUI.ts`

## Current State
- Using `any[]` for choices array
- Casting inquirer.Separator to `any` to avoid type conflicts
- Missing proper type definitions for menu choices

## Recommended Fix
1. Create proper type definitions for menu choices that can handle both regular choices and separators
2. Use discriminated unions to properly type the different choice types
3. Consider upgrading to a more type-safe prompt library or creating wrapper types

## Risk Assessment
- **Severity**: Medium
- **Impact**: Could cause runtime errors if inquirer API changes
- **Effort**: Medium - requires careful refactoring of the UI layer

## Workaround
Currently using `any` types with careful runtime checks. This works but reduces compile-time safety.