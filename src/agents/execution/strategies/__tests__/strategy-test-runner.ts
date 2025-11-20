#!/usr/bin/env bun

/**
 * Test runner that uses the ACTUAL FlattenedChronologicalStrategy
 * to generate accurate filtering results for visualization
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/delegation";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import { MOCK_AGENTS, MockEventGenerator } from "./mock-event-generator";

interface VisualizationData {
    scenario: string;
    events: Array<{
        id: string;
        pubkey: string;
        content: string;
        created_at: number;
        tags: string[][];
        visibleTo: Record<string, { visible: boolean; reason?: string }>;
    }>;
}

async function generateVisualizationData(): Promise<Record<string, VisualizationData>> {
    await DelegationRegistry.initialize();

    const strategy = new FlattenedChronologicalStrategy();
    const generator = new MockEventGenerator();
    const scenarios = generator.generateAllScenarios();

    const results: Record<string, VisualizationData> = {};

    for (const [scenarioName, events] of Object.entries(scenarios)) {
        console.log(`Processing scenario: ${scenarioName}`);

        const visualizationEvents = [];

        for (const event of events) {
            const visibleTo: Record<string, { visible: boolean; reason?: string }> = {};

            // Test visibility for each agent
            for (const [agentKey, agentData] of Object.entries(MOCK_AGENTS)) {
                if (agentKey === "user") continue; // Skip user

                // Find triggering event for this agent
                let triggeringEvent = null;
                for (let i = events.length - 1; i >= 0; i--) {
                    const e = events[i];
                    if (
                        e.pubkey === agentData.pubkey ||
                        e.tags.some((tag) => tag[0] === "p" && tag[1] === agentData.pubkey)
                    ) {
                        triggeringEvent = e;
                        break;
                    }
                }

                if (!triggeringEvent) {
                    visibleTo[agentData.pubkey] = { visible: false, reason: "No triggering event" };
                    continue;
                }

                const agent: AgentInstance = {
                    name: agentData.name,
                    slug: agentData.slug,
                    pubkey: agentData.pubkey,
                    role: "assistant",
                    instructions: "Test",
                    tools: [],
                };

                const conversation: Conversation = {
                    id: `test-${scenarioName}`,
                    history: events,
                    participants: new Set(Object.values(MOCK_AGENTS).map((a) => a.pubkey)),
                    agentStates: new Map(),
                    metadata: {},
                    executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
                } as Conversation;

                const context: ExecutionContext = {
                    agent,
                    conversationId: conversation.id,
                    projectPath: "/test/path",
                    triggeringEvent,
                    conversationCoordinator: {
                        threadService: new ThreadService(),
                    } as any,
                    agentPublisher: {} as any,
                    getConversation: () => conversation,
                    isDelegationCompletion: false,
                } as ExecutionContext;

                try {
                    const messages = await strategy.buildMessages(context, triggeringEvent);
                    const messageContents = messages.map((m) =>
                        typeof m.content === "string" ? m.content : JSON.stringify(m.content)
                    );

                    // Check if this event's content appears in messages
                    const isVisible = messageContents.some((c) =>
                        c.includes(event.content.substring(0, 30))
                    );

                    visibleTo[agentData.pubkey] = {
                        visible: isVisible,
                        reason: isVisible ? "In agent's view" : "Filtered out",
                    };
                } catch (error) {
                    console.error(`Error processing agent ${agentData.name}:`, error);
                    visibleTo[agentData.pubkey] = {
                        visible: false,
                        reason: "Error processing",
                    };
                }
            }

            visualizationEvents.push({
                id: event.id || "",
                pubkey: event.pubkey,
                content: event.content || "",
                created_at: event.created_at || 0,
                tags: event.tags,
                visibleTo,
            });
        }

        results[scenarioName] = {
            scenario: scenarioName,
            events: visualizationEvents,
        };
    }

    return results;
}

// Generate and save the data
async function main() {
    console.log("Generating visualization data using ACTUAL strategy...");

    const data = await generateVisualizationData();

    const outputPath = path.join(__dirname, "visualization-data.json");
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

    console.log(`\nVisualization data saved to: ${outputPath}`);
    console.log("\nScenarios processed:");
    for (const scenario of Object.keys(data)) {
        console.log(`  - ${scenario}: ${data[scenario].events.length} events`);
    }

    // Generate updated HTML that uses this data
    const htmlTemplatePath = path.join(__dirname, "agent-perspective-visualization.html");
    const htmlContent = fs.readFileSync(htmlTemplatePath, "utf-8");

    // Replace the hardcoded scenarios with actual data
    const updatedHtml = htmlContent.replace(
        /const scenarios = \{[\s\S]*?\};/,
        `const scenarios = ${JSON.stringify(data, null, 8)};

        // Convert back to simple format for compatibility
        const simpleScenarios = {};
        for (const [name, data] of Object.entries(scenarios)) {
            simpleScenarios[name] = data.events.map(e => ({
                id: e.id,
                pubkey: e.pubkey,
                content: e.content,
                created_at: e.created_at,
                tags: e.tags,
                kind: 1111
            }));
        }
        const scenarios = simpleScenarios;`
    );

    const outputHtmlPath = path.join(__dirname, "agent-perspective-accurate.html");
    fs.writeFileSync(outputHtmlPath, updatedHtml);
    console.log(`\nAccurate HTML saved to: ${outputHtmlPath}`);
}

if (import.meta.main) {
    main().catch(console.error);
}
