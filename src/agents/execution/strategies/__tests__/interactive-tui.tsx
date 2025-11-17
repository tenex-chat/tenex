/* @ts-nocheck */
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Box, Text, render, useApp, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import { type SignedConversation, SignedEventGenerator } from "./generate-signed-events";

interface AppState {
    loading: boolean;
    scenarios: SignedConversation[];
    currentScenarioIndex: number;
    selectedAgentIndex: number;
    visibilityMap: Map<string, Set<string>>; // agentPubkey -> visible event IDs
}

function InteractiveTUI() {
    const { exit } = useApp();
    const [state, setState] = useState<AppState>({
        loading: true,
        scenarios: [],
        currentScenarioIndex: 0,
        selectedAgentIndex: 0,
        visibilityMap: new Map(),
    });

    // Initialize and generate scenarios
    useEffect(() => {
        (async () => {
            await DelegationRegistry.initialize();
            const generator = new SignedEventGenerator();
            const scenarios = await generator.generateAllScenarios();

            setState((prev) => ({ ...prev, scenarios, loading: false }));
        })();
    }, []);

    // Compute visibility when scenario or agent changes
    useEffect(() => {
        if (state.scenarios.length === 0) return;

        (async () => {
            const scenario = state.scenarios[state.currentScenarioIndex];
            const strategy = new FlattenedChronologicalStrategy();
            const visibilityMap = new Map<string, Set<string>>();

            for (const signedAgent of scenario.agents) {
                // Find triggering event
                let triggeringEvent: NDKEvent | null = null;
                for (let i = scenario.events.length - 1; i >= 0; i--) {
                    const event = scenario.events[i];
                    if (
                        event.pubkey === signedAgent.agent.pubkey ||
                        event.tags.some(
                            (tag) => tag[0] === "p" && tag[1] === signedAgent.agent.pubkey
                        )
                    ) {
                        triggeringEvent = event;
                        break;
                    }
                }

                if (!triggeringEvent) continue;

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
                    conversationCoordinator: { threadService: new ThreadService() } as any,
                    agentPublisher: {} as any,
                    getConversation: () => conversation,
                    isDelegationCompletion: false,
                } as ExecutionContext;

                try {
                    const messages = await strategy.buildMessages(context, triggeringEvent);
                    const visibleIds = new Set<string>();

                    // Check which events appear in the messages
                    for (const event of scenario.events) {
                        const eventPreview = event.content.substring(0, 40);
                        const isVisible = messages.some((msg) => {
                            const content =
                                typeof msg.content === "string"
                                    ? msg.content
                                    : JSON.stringify(msg.content);
                            return content.includes(eventPreview);
                        });
                        if (isVisible) {
                            visibleIds.add(event.id!);
                        }
                    }

                    visibilityMap.set(signedAgent.agent.pubkey, visibleIds);
                } catch (error) {
                    visibilityMap.set(signedAgent.agent.pubkey, new Set());
                }
            }

            setState((prev) => ({ ...prev, visibilityMap }));
        })();
    }, [state.currentScenarioIndex, state.scenarios]);

    // Handle keyboard input
    useInput((input, key) => {
        if (input === "q" || key.escape) {
            exit();
        } else if (key.leftArrow && state.currentScenarioIndex > 0) {
            setState((prev) => ({
                ...prev,
                currentScenarioIndex: prev.currentScenarioIndex - 1,
                selectedAgentIndex: 0,
            }));
        } else if (key.rightArrow && state.currentScenarioIndex < state.scenarios.length - 1) {
            setState((prev) => ({
                ...prev,
                currentScenarioIndex: prev.currentScenarioIndex + 1,
                selectedAgentIndex: 0,
            }));
        } else if (key.upArrow && state.selectedAgentIndex > 0) {
            setState((prev) => ({ ...prev, selectedAgentIndex: prev.selectedAgentIndex - 1 }));
        } else if (key.downArrow && state.scenarios.length > 0) {
            const maxIndex = state.scenarios[state.currentScenarioIndex].agents.length - 1;
            if (state.selectedAgentIndex < maxIndex) {
                setState((prev) => ({ ...prev, selectedAgentIndex: prev.selectedAgentIndex + 1 }));
            }
        }
    });

    if (state.loading) {
        return (
            <Box padding={1}>
                <Text color="yellow">⏳ Generating signed Nostr events...</Text>
            </Box>
        );
    }

    const scenario = state.scenarios[state.currentScenarioIndex];
    const selectedAgent = scenario.agents[state.selectedAgentIndex];
    const visibleIds = state.visibilityMap.get(selectedAgent.agent.pubkey) || new Set();

    // Build tree
    const buildTree = (events: NDKEvent[]) => {
        const map = new Map(events.map((e) => [e.id!, e]));
        const roots: NDKEvent[] = [];

        for (const event of events) {
            const parentTag = event.tags.find((tag) => tag[0] === "e");
            if (!parentTag || !map.has(parentTag[1])) {
                roots.push(event);
            }
        }

        return roots;
    };

    const renderTree = (
        event: NDKEvent,
        depth = 0,
        isLast = true,
        prefix = ""
    ): React.ReactElement[] => {
        const isVisible = visibleIds.has(event.id!);
        const color = isVisible ? "green" : "dim";
        const symbol = isVisible ? "✓" : "✗";
        const connector = isLast ? "└─" : "├─";
        const line = depth > 0 ? `${prefix + connector} ` : "";

        const author =
            scenario.agents.find((a) => a.agent.pubkey === event.pubkey)?.agent.name ||
            (event.pubkey === scenario.user.pubkey ? "User" : event.pubkey.substring(0, 8));
        const content = event.content.substring(0, 70);

        const children = scenario.events
            .filter((e) => {
                const parentTag = e.tags.find((tag) => tag[0] === "e");
                return parentTag && parentTag[1] === event.id;
            })
            .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

        const elements: React.ReactElement[] = [
            <Text key={event.id} color={color}>
                {line}
                {symbol} <Text bold>{author}</Text>: {content}
                {content.length < event.content.length ? "..." : ""}
            </Text>,
        ];

        children.forEach((child, index) => {
            const childIsLast = index === children.length - 1;
            const childPrefix = depth > 0 ? prefix + (isLast ? "   " : "│  ") : "";
            elements.push(...renderTree(child, depth + 1, childIsLast, childPrefix));
        });

        return elements;
    };

    const roots = buildTree(scenario.events);
    const allTreeElements: React.ReactElement[] = [];
    roots.forEach((root, index) => {
        allTreeElements.push(...renderTree(root, 0, index === roots.length - 1));
    });

    const visibleCount = visibleIds.size;
    const totalCount = scenario.events.length;
    const percentage = Math.round((visibleCount / totalCount) * 100);

    return (
        <Box flexDirection="column" padding={1}>
            {/* Header */}
            <Box borderStyle="double" borderColor="cyan" paddingX={1} marginBottom={1}>
                <Text bold color="cyan">
                    🔍 Interactive Nostr Threading Visualizer (REAL Strategy)
                </Text>
            </Box>

            {/* Scenario info */}
            <Box marginBottom={1}>
                <Text>
                    Scenario{" "}
                    <Text color="yellow">
                        [{state.currentScenarioIndex + 1}/{state.scenarios.length}]
                    </Text>
                    :{" "}
                    <Text bold color="white">
                        {scenario.name}
                    </Text>
                </Text>
            </Box>

            <Box marginBottom={1}>
                <Text dimColor>{scenario.description}</Text>
            </Box>

            {/* Agent selector */}
            <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="yellow"
                paddingX={1}
                marginBottom={1}
            >
                <Text bold>Select Agent (↑↓):</Text>
                {scenario.agents.map((agent, index) => {
                    const selected = index === state.selectedAgentIndex;
                    const agentVisibleIds =
                        state.visibilityMap.get(agent.agent.pubkey) || new Set();
                    const agentPercentage = Math.round((agentVisibleIds.size / totalCount) * 100);

                    return (
                        <Text key={agent.agent.pubkey} color={selected ? "green" : "white"}>
                            {selected ? "→ " : "  "}
                            {agent.agent.name} ({agent.agent.role}) - sees {agentVisibleIds.size}/
                            {totalCount} ({agentPercentage}%)
                        </Text>
                    );
                })}
            </Box>

            {/* Thread view */}
            <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="green"
                paddingX={1}
                marginBottom={1}
            >
                <Text bold color="green">
                    {selectedAgent.agent.name}'s View - {visibleCount}/{totalCount} events (
                    {percentage}%)
                </Text>
                <Text dimColor>Green = Visible | Gray = Filtered Out</Text>
                <Box flexDirection="column" marginTop={1}>
                    {allTreeElements}
                </Box>
            </Box>

            {/* Controls */}
            <Box borderStyle="single" borderColor="yellow" paddingX={1}>
                <Text>
                    <Text color="cyan">←→</Text> Change scenario | <Text color="cyan">↑↓</Text>{" "}
                    Select agent | <Text color="red">Q/ESC</Text> Quit
                </Text>
            </Box>
        </Box>
    );
}

async function main() {
    render(<InteractiveTUI />);
}

if (import.meta.main) {
    main().catch(console.error);
}
