#!/usr/bin/env bun
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { SignedEventGenerator, SignedConversation, SignedAgent } from './generate-signed-events';
import { FlattenedChronologicalStrategy } from '../FlattenedChronologicalStrategy';
import { DelegationRegistry } from '@/services/DelegationRegistry';
import { ThreadService } from '@/conversations/services/ThreadService';
import type { ExecutionContext } from '../../types';
import type { Conversation } from '@/conversations';
import { NDKEvent } from '@nostr-dev-kit/ndk';

interface AppState {
    scenarios: SignedConversation[];
    currentScenarioIndex: number;
    selectedAgentIndex: number;
    loading: boolean;
    agentMessages: Map<string, any[]>;
}

// Build tree structure for display
interface EventNode {
    event: NDKEvent;
    children: EventNode[];
    depth: number;
}

function buildTree(events: NDKEvent[]): EventNode[] {
    const eventMap = new Map<string, EventNode>();

    // Create nodes
    for (const event of events) {
        eventMap.set(event.id!, { event, children: [], depth: 0 });
    }

    // Build parent-child relationships
    const roots: EventNode[] = [];
    for (const event of events) {
        const node = eventMap.get(event.id!)!;
        const parentTag = event.tags.find(tag => tag[0] === 'e');

        if (!parentTag || !parentTag[1]) {
            roots.push(node);
            node.depth = 0;
        } else {
            const parent = eventMap.get(parentTag[1]);
            if (parent) {
                parent.children.push(node);
                node.depth = parent.depth + 1;
            } else {
                roots.push(node);
                node.depth = 0;
            }
        }
    }

    // Sort children by created_at
    function sortChildren(node: EventNode) {
        if (node.children.length > 0) {
            node.children.sort((a, b) => (a.event.created_at || 0) - (b.event.created_at || 0));
            node.children.forEach(sortChildren);
        }
    }
    roots.forEach(sortChildren);

    return roots;
}

// Render a single event in the tree
function EventDisplay({ node, isVisible, indent = 0, isLast = false, prefix = '' }: {
    node: EventNode;
    isVisible: boolean;
    indent?: number;
    isLast?: boolean;
    prefix?: string;
}) {
    const author = node.event.pubkey.substring(0, 8);
    const content = node.event.content.substring(0, 60);
    const color = isVisible ? 'green' : 'gray';
    const symbol = isVisible ? '✓' : '✗';

    const connector = isLast ? '└─' : '├─';
    const line = indent > 0 ? prefix + connector : '';

    return (
        <>
            <Box>
                <Text color={color}>
                    {line} {symbol} {author}: {content}
                    {node.event.content.length > 60 ? '...' : ''}
                </Text>
            </Box>
            {node.children.map((child, index) => {
                const isChildLast = index === node.children.length - 1;
                const childPrefix = indent > 0 ? prefix + (isLast ? '   ' : '│  ') : '   ';
                return (
                    <EventDisplay
                        key={child.event.id}
                        node={child}
                        isVisible={isVisible}
                        indent={indent + 1}
                        isLast={isChildLast}
                        prefix={childPrefix}
                    />
                );
            })}
        </>
    );
}

// Main App Component
function ThreadingVisualizerApp() {
    const { exit } = useApp();
    const [state, setState] = useState<AppState>({
        scenarios: [],
        currentScenarioIndex: 0,
        selectedAgentIndex: 0,
        loading: true,
        agentMessages: new Map()
    });

    // Generate scenarios on mount
    useEffect(() => {
        (async () => {
            try {
                await DelegationRegistry.initialize();
                const generator = new SignedEventGenerator();
                const scenarios = await generator.generateAllScenarios();

                setState(prev => ({
                    ...prev,
                    scenarios,
                    loading: false
                }));
            } catch (error) {
                console.error('Failed to generate scenarios:', error);
                exit();
            }
        })();
    }, []);

    // Build agent messages when scenario or agent changes
    useEffect(() => {
        if (state.scenarios.length === 0 || state.loading) return;

        (async () => {
            const scenario = state.scenarios[state.currentScenarioIndex];
            const strategy = new FlattenedChronologicalStrategy();
            const agentMessages = new Map<string, any[]>();

            for (const signedAgent of scenario.agents) {
                // Find triggering event for this agent
                let triggeringEvent: NDKEvent | null = null;
                for (let i = scenario.events.length - 1; i >= 0; i--) {
                    const event = scenario.events[i];
                    if (event.pubkey === signedAgent.agent.pubkey ||
                        event.tags.some(tag => tag[0] === 'p' && tag[1] === signedAgent.agent.pubkey)) {
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
                        ...scenario.agents.map(a => a.agent.pubkey)
                    ]),
                    agentStates: new Map(),
                    metadata: {},
                    executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() }
                } as Conversation;

                const context: ExecutionContext = {
                    agent: signedAgent.agent,
                    conversationId: conversation.id,
                    projectPath: '/test/path',
                    triggeringEvent,
                    conversationCoordinator: {
                        threadService: new ThreadService()
                    } as any,
                    agentPublisher: {} as any,
                    getConversation: () => conversation,
                    isDelegationCompletion: false
                } as ExecutionContext;

                try {
                    const messages = await strategy.buildMessages(context, triggeringEvent);
                    agentMessages.set(signedAgent.agent.pubkey, messages);
                } catch (error) {
                    console.error(`Error building messages for ${signedAgent.agent.name}:`, error);
                    agentMessages.set(signedAgent.agent.pubkey, []);
                }
            }

            setState(prev => ({
                ...prev,
                agentMessages
            }));
        })();
    }, [state.currentScenarioIndex, state.selectedAgentIndex, state.scenarios]);

    // Handle keyboard input
    useInput((input, key) => {
        if (input === 'q' || key.escape) {
            exit();
        } else if (key.leftArrow && state.currentScenarioIndex > 0) {
            setState(prev => ({
                ...prev,
                currentScenarioIndex: prev.currentScenarioIndex - 1,
                selectedAgentIndex: 0
            }));
        } else if (key.rightArrow && state.currentScenarioIndex < state.scenarios.length - 1) {
            setState(prev => ({
                ...prev,
                currentScenarioIndex: prev.currentScenarioIndex + 1,
                selectedAgentIndex: 0
            }));
        } else if (key.upArrow && state.selectedAgentIndex > 0) {
            setState(prev => ({
                ...prev,
                selectedAgentIndex: prev.selectedAgentIndex - 1
            }));
        } else if (key.downArrow && state.scenarios.length > 0) {
            const maxIndex = state.scenarios[state.currentScenarioIndex].agents.length - 1;
            if (state.selectedAgentIndex < maxIndex) {
                setState(prev => ({
                    ...prev,
                    selectedAgentIndex: prev.selectedAgentIndex + 1
                }));
            }
        }
    });

    if (state.loading) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text color="yellow">Loading scenarios...</Text>
            </Box>
        );
    }

    if (state.scenarios.length === 0) {
        return (
            <Box flexDirection="column" padding={1}>
                <Text color="red">No scenarios loaded</Text>
            </Box>
        );
    }

    const scenario = state.scenarios[state.currentScenarioIndex];
    const selectedAgent = scenario.agents[state.selectedAgentIndex];
    const agentMessages = state.agentMessages.get(selectedAgent.agent.pubkey) || [];

    // Build visible event IDs set
    const visibleEventIds = new Set<string>();
    for (const message of agentMessages) {
        // Extract event IDs from message content or structure
        // This is simplified - in real code, you'd track which events are included
        for (const event of scenario.events) {
            if (typeof message.content === 'string' && message.content.includes(event.content.substring(0, 30))) {
                visibleEventIds.add(event.id!);
            }
        }
    }

    const tree = buildTree(scenario.events);

    return (
        <Box flexDirection="column" padding={1}>
            {/* Header */}
            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                <Text bold color="cyan">
                    Nostr Threading Visualizer - ACTUAL Strategy Implementation
                </Text>
            </Box>

            <Box marginTop={1}>
                <Text>
                    Scenario [{state.currentScenarioIndex + 1}/{state.scenarios.length}]: <Text bold>{scenario.name}</Text>
                </Text>
            </Box>

            <Box marginBottom={1}>
                <Text dimColor>{scenario.description}</Text>
            </Box>

            {/* Main content - side by side */}
            <Box>
                {/* Left: Full conversation tree */}
                <Box flexDirection="column" width="50%" borderStyle="single" borderColor="white" paddingX={1}>
                    <Box marginBottom={1}>
                        <Text bold underline>Full Conversation ({scenario.events.length} events)</Text>
                    </Box>
                    {tree.map((root, index) => (
                        <EventDisplay
                            key={root.event.id}
                            node={root}
                            isVisible={true}
                            isLast={index === tree.length - 1}
                        />
                    ))}
                </Box>

                {/* Right: Agent perspective */}
                <Box flexDirection="column" width="50%" borderStyle="single" borderColor="green" paddingX={1}>
                    <Box marginBottom={1}>
                        <Text bold underline color="green">
                            {selectedAgent.agent.name}'s View ({agentMessages.length} messages)
                        </Text>
                    </Box>

                    {tree.map((root, index) => {
                        function renderNode(node: EventNode, depth: number = 0, isLast: boolean = false, prefix: string = ''): React.ReactElement | null {
                            const isVisible = visibleEventIds.has(node.event.id!);
                            const connector = isLast ? '└─' : '├─';
                            const line = depth > 0 ? prefix + connector : '';
                            const color = isVisible ? 'green' : 'gray';
                            const symbol = isVisible ? '✓' : '✗';
                            const author = node.event.pubkey.substring(0, 8);
                            const content = node.event.content.substring(0, 40);

                            return (
                                <Box key={node.event.id} flexDirection="column">
                                    <Text color={color}>
                                        {line} {symbol} {author}: {content}
                                        {node.event.content.length > 40 ? '...' : ''}
                                    </Text>
                                    {node.children.map((child, childIndex) => {
                                        const isChildLast = childIndex === node.children.length - 1;
                                        const childPrefix = depth > 0 ? prefix + (isLast ? '   ' : '│  ') : '   ';
                                        return renderNode(child, depth + 1, isChildLast, childPrefix);
                                    })}
                                </Box>
                            );
                        }

                        return renderNode(root, 0, index === tree.length - 1);
                    })}
                </Box>
            </Box>

            {/* Footer with controls */}
            <Box marginTop={1} borderStyle="single" borderColor="yellow" paddingX={1}>
                <Text>
                    <Text color="cyan">←→</Text> Change scenario | <Text color="cyan">↑↓</Text> Change agent |{' '}
                    Agent: <Text bold color="yellow">{selectedAgent.agent.name}</Text> |{' '}
                    <Text color="red">Q</Text> Quit
                </Text>
            </Box>

            {/* Stats */}
            <Box marginTop={1}>
                <Text>
                    Events: {scenario.events.length} | Visible to {selectedAgent.agent.name}: {visibleEventIds.size} |{' '}
                    Filtered: {scenario.events.length - visibleEventIds.size}
                </Text>
            </Box>
        </Box>
    );
}

// Run the app
async function main() {
    render(<ThreadingVisualizerApp />);
}

if (import.meta.main) {
    main().catch(console.error);
}
