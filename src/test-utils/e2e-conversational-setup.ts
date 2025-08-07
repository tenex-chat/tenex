import { conversationalLogger } from "./conversational-logger";

/**
 * Global setup for E2E tests to enable conversational logging when DEBUG=true
 * This can be imported and used to automatically enable conversational output
 * without modifying individual test files.
 */
export function setupConversationalLogging() {
    if (process.env.DEBUG === 'true') {
        conversationalLogger.reset();
        
        // Log a banner for the test session
        console.log('\n🎭 E2E Test Session with Conversational Logging');
        console.log(`📅 ${new Date().toISOString()}`);
        console.log(`${'='.repeat(60)}`);
        
        return true;
    }
    return false;
}

/**
 * Helper to wrap test execution with conversational logging
 */
export function withConversationalLogging<T>(testName: string, testFn: () => Promise<T>): Promise<T> {
    if (process.env.DEBUG === 'true') {
        conversationalLogger.logTestStart(testName);
        
        return testFn()
            .then((result) => {
                conversationalLogger.logTestEnd(true, testName);
                return result;
            })
            .catch((error) => {
                conversationalLogger.logTestEnd(false, testName);
                throw error;
            });
    } else {
        return testFn();
    }
}

/**
 * Auto-enable conversational logging if DEBUG is set
 * Can be imported at the top of test files to automatically enable
 */
if (process.env.DEBUG === 'true') {
    setupConversationalLogging();
}
