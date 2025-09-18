# Self-Delegation Restriction Implementation

## Overview
This document describes the implementation of self-delegation restrictions in the TENEX delegation system. The restriction ensures that agents cannot delegate tasks to themselves except when using the `delegate_phase` tool for phase transitions.

## Changes Made

### 1. Core Service Validation
**File:** `src/services/DelegationService.ts`
- Added validation in the `execute()` method to check for self-delegation attempts
- Only allows self-delegation when a `phase` is provided in the intent (indicating use of `delegate_phase` tool)
- Throws clear error messages when self-delegation is attempted without phase

### 2. Individual Tool Validations
Added early validation in each delegation tool to provide clearer error messages:

**File:** `src/tools/implementations/delegate.ts`
- Added check to prevent self-delegation in regular delegate tool
- Validates before creating DelegationService instance

**File:** `src/tools/implementations/delegate_followup.ts`
- Added check to prevent self-delegation in follow-up tool
- Validates after resolving recipient to pubkey

**File:** `src/tools/implementations/delegate_external.ts`
- Added check to prevent self-delegation in external delegation tool
- Moved NDK initialization after validation to avoid unnecessary initialization
- Validates after parsing recipient

**File:** `src/tools/implementations/delegate_phase.ts`
- NO CHANGES - This tool explicitly allows self-delegation for phase transitions
- Documentation already indicates self-delegation is permitted

### 3. Test Coverage
Added comprehensive test coverage for the new validation:

**File:** `src/services/__tests__/DelegationService.simple-validation.test.ts`
- Tests that self-delegation is rejected when phase is not provided
- Tests that self-delegation is allowed when phase is provided
- Tests that delegation to others works normally

**File:** `src/tools/implementations/__tests__/delegate-tool-validation.test.ts`
- Tests self-delegation rejection for `delegate` tool (by slug, pubkey, and in mixed recipients)
- Tests self-delegation rejection for `delegate_followup` tool
- Tests self-delegation rejection for `delegate_external` tool

## Behavior Summary

### ❌ Self-delegation NOT allowed:
- `delegate` tool - agents cannot delegate to themselves
- `delegate_followup` tool - agents cannot send follow-ups to themselves
- `delegate_external` tool - agents cannot delegate to themselves as external agents
- `ask` tool - doesn't support self-delegation (always goes to project owner)

### ✅ Self-delegation IS allowed:
- `delegate_phase` tool - agents can transition phases by delegating to themselves
- This is the ONLY tool that permits self-delegation

### Error Messages
When self-delegation is attempted with prohibited tools, users receive clear error messages:
- Identifies which tool was used
- Names the agent attempting self-delegation
- Suggests using `delegate_phase` if phase transition is intended

## Technical Details

### Detection Method
Self-delegation is detected by comparing:
- The delegating agent's pubkey (`context.agent.pubkey`)
- The resolved recipient pubkeys (after slug/npub resolution)

### Phase Detection
The system determines if `delegate_phase` was used by checking:
- Presence of `phase` field in the DelegationIntent
- This field is only set by `delegate_phase` tool

### Validation Order
1. Tool-level validation (immediate, clear error messages)
2. Service-level validation (backup validation, catches any missed cases)

## Testing
All new validations are covered by automated tests:
- 8 new test cases added
- All tests passing
- No regression in existing tests related to our changes

## Migration Notes
- No backwards compatibility issues
- Existing delegations to other agents continue to work unchanged
- Only self-delegation attempts are affected by these changes