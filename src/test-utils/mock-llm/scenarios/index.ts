export * from "./orchestrator-workflow";
export * from "./error-handling";
export * from "./state-persistence";

import { orchestratorWorkflowScenario } from "./orchestrator-workflow";
import { errorHandlingScenario } from "./error-handling";
import { statePersistenceScenario } from "./state-persistence";
import type { MockLLMScenario } from "../types";

/**
 * All available mock scenarios for testing
 */
export const allScenarios: MockLLMScenario[] = [
    orchestratorWorkflowScenario,
    errorHandlingScenario,
    statePersistenceScenario
];

/**
 * Get a specific scenario by name
 */
export function getScenario(name: string): MockLLMScenario | undefined {
    return allScenarios.find(s => s.name === name);
}

/**
 * Create a custom scenario for specific test cases
 */
export function createScenario(
    name: string,
    description: string,
    responses: MockLLMScenario['responses']
): MockLLMScenario {
    return { name, description, responses };
}