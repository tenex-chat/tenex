export * from "./orchestrator-workflow";
export * from "./error-handling";
export * from "./state-persistence";
export * from "./routing-decisions";
export * from "./performance-testing";
export * from "./concurrency-workflow";
export * from "./inventory-generation";
export * from "./network-resilience";

import { orchestratorWorkflowScenario } from "./orchestrator-workflow";
import { errorHandlingScenario } from "./error-handling";
import { statePersistenceScenario } from "./state-persistence";
import { routingDecisions } from "./routing-decisions";
import { performanceTestingScenario } from "./performance-testing";
import { concurrencyWorkflowScenarios } from "./concurrency-workflow";
import { inventoryGenerationScenario } from "./inventory-generation";
import { networkResilienceScenario } from "./network-resilience";
import type { MockLLMScenario } from "../types";

/**
 * All available mock scenarios for testing
 */
export const allScenarios: MockLLMScenario[] = [
    orchestratorWorkflowScenario,
    errorHandlingScenario,
    statePersistenceScenario,
    routingDecisions,
    performanceTestingScenario,
    inventoryGenerationScenario,
    networkResilienceScenario
];

/**
 * Concurrency testing scenarios
 */
export const concurrencyScenarios = concurrencyWorkflowScenarios;

// Add concurrency scenarios to all scenarios
allScenarios.push(...concurrencyWorkflowScenarios);

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