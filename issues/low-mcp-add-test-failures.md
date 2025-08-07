# Low Priority: MCP Add Command Test Failures

## Issue
Several test cases in `src/commands/mcp/__tests__/add.test.ts` are failing:

1. "should validate server name uniqueness" - Expected rejection but promise resolved
2. "should validate command exists" - Expected rejection but promise resolved  
3. "should skip validation for special commands" - mockWhich was called when it shouldn't have been
4. "should reject duplicate server names" - Expected rejection but promise resolved

## Impact
- Test suite reliability
- Potential validation issues in MCP add command
- No production impact currently observed

## Suggested Fix
The tests appear to be expecting the command to throw errors during validation, but the actual implementation may be handling errors differently (e.g., logging errors and exiting gracefully instead of throwing).

Review the MCP add command implementation to ensure:
1. Proper validation is occurring
2. Tests match the actual error handling behavior
3. Consider whether the command should throw or handle errors gracefully

## Files Affected
- `src/commands/mcp/__tests__/add.test.ts`
- `src/commands/mcp/add.ts` (implementation)

## Risk Level
Low - These are test failures, not production bugs. The command may be working correctly but the tests need updating to match the actual behavior.