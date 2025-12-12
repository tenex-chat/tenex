#!/usr/bin/env bun

/**
 * Run the threading TUI visualizer
 *
 * This generates REAL signed Nostr events and shows how the ACTUAL
 * FlattenedChronologicalStrategy filters them for different agents.
 *
 * Usage: bun run src/agents/execution/strategies/__tests__/run-tui.ts
 */

import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistryService } from "@/services/delegation";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import { SignedEventGenerator } from "./generate-signed-events";

async function main() {
    console.log("🔧 Generating signed Nostr events...\n");

    await DelegationRegistryService.initialize();

    const generator = new SignedEventGenerator();
    const scenarios = await generator.generateAllScenarios();

    console.log(`✅ Generated ${scenarios.length} scenarios:\n`);

    for (const scenario of scenarios) {
        console.log(`📋 ${scenario.name}`);
        console.log(`   ${scenario.description}`);
        console.log(`   Events: ${scenario.events.length}`);
        console.log(`   Agents: ${scenario.agents.map((a) => a.agent.name).join(", ")}`);
        console.log("");
    }

    // Test the first scenario
    const scenario = scenarios[0];
    console.log(`\n🔍 Testing "${scenario.name}" with ACTUAL strategy...\n`);

    const strategy = new FlattenedChronologicalStrategy();

    for (const signedAgent of scenario.agents) {
        // Find triggering event
        let triggeringEvent = null;
        for (let i = scenario.events.length - 1; i >= 0; i--) {
            const event = scenario.events[i];
            if (
                event.pubkey === signedAgent.agent.pubkey ||
                event.tags.some((tag) => tag[0] === "p" && tag[1] === signedAgent.agent.pubkey)
            ) {
                triggeringEvent = event;
                break;
            }
        }

        if (!triggeringEvent) {
            console.log(`⚠️  ${signedAgent.agent.name}: No triggering event found`);
            continue;
        }

        const conversation: Conversation = {
            id: scenario.events[0].id!,
            history: scenario.events,
            participants: new Set([
                scenario.user.pubkey,
                ...scenario.agents.map((a) => a.agent.pubkey),
            ]),
            agentStates: new Map(),
            metadata: {},
            executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        } as Conversation;

        const context: ExecutionContext = {
            agent: signedAgent.agent,
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

            console.log(`👤 ${signedAgent.agent.name} (${signedAgent.agent.role})`);
            console.log(`   Triggered by: ${triggeringEvent.id?.substring(0, 8)}`);
            console.log(
                `   Sees ${messages.length} messages out of ${scenario.events.length} events`
            );
            console.log(
                `   Visibility: ${((messages.length / scenario.events.length) * 100).toFixed(0)}%`
            );

            // Show which events are visible
            const visibleEventIds = new Set<string>();
            for (const message of messages) {
                for (const event of scenario.events) {
                    if (
                        typeof message.content === "string" &&
                        message.content.includes(event.content.substring(0, 20))
                    ) {
                        visibleEventIds.add(event.id!);
                    }
                }
            }

            console.log("   Visible events:");
            for (const event of scenario.events) {
                const isVisible = visibleEventIds.has(event.id!);
                const symbol = isVisible ? "✓" : "✗";
                const author =
                    event.pubkey === scenario.user.pubkey
                        ? "User"
                        : scenario.agents.find((a) => a.agent.pubkey === event.pubkey)?.agent
                              .name || "Unknown";
                console.log(
                    `     ${symbol} ${event.id?.substring(0, 8)} (${author}): ${event.content.substring(0, 40)}...`
                );
            }

            console.log("");
        } catch (error) {
            console.error(`❌ Error for ${signedAgent.agent.name}:`, error);
        }
    }

    console.log(
        "\n✅ Done! All events were ACTUALLY signed and processed through the real strategy.\n"
    );
}

main().catch(console.error);
