#!/usr/bin/env bun
import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import NDK, { NDKEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { FlattenedChronologicalStrategy } from '../FlattenedChronologicalStrategy';
import { DelegationRegistry } from '@/services/DelegationRegistry';
import { ThreadService } from '@/conversations/services/ThreadService';
import { PubkeyNameRepository } from '@/services/PubkeyNameRepository';
import { agentStorage } from '@/agents/AgentStorage';
import type { ExecutionContext } from '../../types';
import type { Conversation } from '@/conversations';
import type { AgentInstance } from '@/agents/types';

interface AppState {
    loading: boolean;
    error?: string;
    events: NDKEvent[];
    rootEvent?: NDKEvent;
    participants: Array<{ pubkey: string; name: string; agent?: AgentInstance }>;
    selectedParticipantIndex: number;
    visibilityMap: Map<string, Set<string>>; // pubkey -> visible event IDs
}

async function fetchConversationThread(eventId: string, relayUrls: string[]): Promise<NDKEvent[]> {
    console.log(`Connecting to relays: ${relayUrls.join(', ')}`);
    const ndk = new NDK({ explicitRelayUrls: relayUrls });
    await ndk.connect();

    console.log(`Fetching conversation for event: ${eventId}...`);
    console.log(`Using filters: [{ ids: ["${eventId}"] }, { "#E": ["${eventId}"] }]`);

    // Fetch both root event and all thread replies in a single call
    const filters: NDKFilter[] = [
        { ids: [eventId] },
        { '#E': [eventId] }
    ];
    const allEvents = await ndk.fetchEvents(filters);
    const eventsArray = Array.from(allEvents);

    if (eventsArray.length === 0) {
        throw new Error(
            `No events found for ${eventId} on relays: ${relayUrls.join(', ')}\n` +
            `Filters used: [{ ids: ["${eventId}"] }, { "#E": ["${eventId}"] }]\n` +
            `Try specifying the correct relay: bun run ... <event-id> wss://tenex.chat`
        );
    }

    const rootEvent = eventsArray.find(e => e.id === eventId);
    if (!rootEvent) {
        throw new Error(
            `Root event ${eventId} not found, but found ${eventsArray.length} related events\n` +
            `This shouldn't happen - the event might be in the thread but not fetchable by ID`
        );
    }

    console.log(`Fetched ${eventsArray.length} events total in thread (including root)`);

    return eventsArray.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

async function getParticipantName(pubkey: string): Promise<string> {
    // First check if it's an agent in storage
    try {
        await agentStorage.initialize();
        const agent = await agentStorage.loadAgent(pubkey);
        if (agent) {
            return agent.slug;
        }
    } catch (error) {
        // Not an agent or error loading
    }

    // Try pubkey name repository for user profiles
    try {
        const name = await PubkeyNameRepository.getInstance().getName(pubkey);
        if (name !== "User") { // PubkeyNameRepository returns "User" as default
            return name;
        }
    } catch {
        // Fallback below
    }

    // Last resort: truncated pubkey
    return pubkey.substring(0, 8);
}

function NostrConversationViewer({ eventId, relayUrls }: { eventId: string; relayUrls: string[] }) {
    const { exit } = useApp();
    const [state, setState] = useState<AppState>({
        loading: true,
        events: [],
        participants: [],
        selectedParticipantIndex: 0,
        visibilityMap: new Map()
    });

    // Fetch events on mount
    useEffect(() => {
        (async () => {
            try {
                await DelegationRegistry.initialize();

                // Fetch conversation
                const events = await fetchConversationThread(eventId, relayUrls);
                const rootEvent = events[0];

                // Get unique participants
                const pubkeys = new Set<string>();
                events.forEach(e => {
                    pubkeys.add(e.pubkey);
                    e.tags.forEach(tag => {
                        if (tag[0] === 'p' || tag[0] === 'P') {
                            pubkeys.add(tag[1]);
                        }
                    });
                });

                // Get names for all participants
                const participants = await Promise.all(
                    Array.from(pubkeys).map(async pubkey => {
                        const name = await getParticipantName(pubkey);
                        // For now, we don't have agent instances, so we mark participants as potential agents
                        // based on whether they have a P tag (indicating they're an agent)
                        const isAgent = events.some(e =>
                            e.pubkey === pubkey && e.tags.some(t => t[0] === 'P' && t[1] === pubkey)
                        );
                        return { pubkey, name, agent: isAgent ? { pubkey, name } as any : undefined };
                    })
                );

                setState(prev => ({
                    ...prev,
                    events,
                    rootEvent,
                    participants,
                    loading: false
                }));
            } catch (error) {
                setState(prev => ({
                    ...prev,
                    loading: false,
                    error: error instanceof Error ? error.message : String(error)
                }));
            }
        })();
    }, [eventId]);

    // Compute visibility when events or selection changes
    useEffect(() => {
        if (state.events.length === 0 || !state.rootEvent) return;

        (async () => {
            const strategy = new FlattenedChronologicalStrategy();
            const visibilityMap = new Map<string, Set<string>>();

            for (const participant of state.participants) {
                // Skip if not an agent
                if (!participant.agent) {
                    continue;
                }

                // Find triggering event for this participant
                let triggeringEvent: NDKEvent | null = null;
                for (let i = state.events.length - 1; i >= 0; i--) {
                    const event = state.events[i];
                    if (event.pubkey === participant.pubkey ||
                        event.tags.some(tag => (tag[0] === 'p' || tag[0] === 'P') && tag[1] === participant.pubkey)) {
                        triggeringEvent = event;
                        break;
                    }
                }

                if (!triggeringEvent) {
                    visibilityMap.set(participant.pubkey, new Set());
                    continue;
                }

                const conversation: Conversation = {
                    id: state.rootEvent.id!,
                    history: state.events,
                    participants: new Set(state.participants.map(p => p.pubkey)),
                    agentStates: new Map(),
                    metadata: {},
                    executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() }
                } as Conversation;

                const context: ExecutionContext = {
                    agent: participant.agent,
                    conversationId: conversation.id,
                    projectPath: '/nostr/viewer',
                    triggeringEvent,
                    conversationCoordinator: { threadService: new ThreadService() } as any,
                    agentPublisher: {} as any,
                    getConversation: () => conversation,
                    isDelegationCompletion: false
                } as ExecutionContext;

                try {
                    const messages = await strategy.buildMessages(context, triggeringEvent);
                    const visibleIds = new Set<string>();

                    // Check which events appear in the messages
                    for (const event of state.events) {
                        const eventPreview = event.content.substring(0, 40);
                        const isVisible = messages.some(msg => {
                            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                            return content.includes(eventPreview);
                        });
                        if (isVisible) {
                            visibleIds.add(event.id!);
                        }
                    }

                    visibilityMap.set(participant.pubkey, visibleIds);
                } catch (error) {
                    console.error(`Error computing visibility for ${participant.name}:`, error);
                    visibilityMap.set(participant.pubkey, new Set());
                }
            }

            setState(prev => ({ ...prev, visibilityMap }));
        })();
    }, [state.events, state.participants]);

    // Handle keyboard input
    useInput((input, key) => {
        if (input === 'q' || key.escape) {
            exit();
        } else if (key.upArrow && state.selectedParticipantIndex > 0) {
            setState(prev => ({ ...prev, selectedParticipantIndex: prev.selectedParticipantIndex - 1 }));
        } else if (key.downArrow && state.selectedParticipantIndex < state.participants.length - 1) {
            setState(prev => ({ ...prev, selectedParticipantIndex: prev.selectedParticipantIndex + 1 }));
        }
    });

    if (state.loading) {
        return (
            <Box padding={1}>
                <Text color="yellow">⏳ Fetching conversation from Nostr relays...</Text>
            </Box>
        );
    }

    if (state.error) {
        return (
            <Box padding={1} flexDirection="column">
                <Text color="red">❌ Error: {state.error}</Text>
                <Text dimColor>Press Q to quit</Text>
            </Box>
        );
    }

    if (state.events.length === 0) {
        return (
            <Box padding={1}>
                <Text color="yellow">No events found</Text>
            </Box>
        );
    }

    const selectedParticipant = state.participants[state.selectedParticipantIndex];
    const visibleIds = state.visibilityMap.get(selectedParticipant.pubkey) || new Set();

    // Build tree
    const buildTree = (events: NDKEvent[]) => {
        const map = new Map(events.map(e => [e.id!, e]));
        const roots: NDKEvent[] = [];

        for (const event of events) {
            const parentTag = event.tags.find(tag => tag[0] === 'e');
            if (!parentTag || !map.has(parentTag[1])) {
                roots.push(event);
            }
        }

        return roots;
    };

    const renderTree = (event: NDKEvent, depth: number = 0, isLast: boolean = true, prefix: string = ''): React.ReactElement[] => {
        const isVisible = selectedParticipant.agent ? visibleIds.has(event.id!) : true;
        const color = isVisible ? 'green' : 'dim';
        const symbol = selectedParticipant.agent ? (isVisible ? '✓' : '✗') : '•';
        const connector = isLast ? '└─' : '├─';
        const line = depth > 0 ? prefix + connector + ' ' : '';

        const authorParticipant = state.participants.find(p => p.pubkey === event.pubkey);
        const author = authorParticipant?.name || event.pubkey.substring(0, 8);
        const content = event.content.substring(0, 70);

        const children = state.events.filter(e => {
            const parentTag = e.tags.find(tag => tag[0] === 'e');
            return parentTag && parentTag[1] === event.id;
        }).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

        const elements: React.ReactElement[] = [
            <Text key={event.id} color={color}>
                {line}{symbol} <Text bold>{author}</Text>: {content}{content.length < event.content.length ? '...' : ''}
            </Text>
        ];

        children.forEach((child, index) => {
            const childIsLast = index === children.length - 1;
            const childPrefix = depth > 0 ? prefix + (isLast ? '   ' : '│  ') : '';
            elements.push(...renderTree(child, depth + 1, childIsLast, childPrefix));
        });

        return elements;
    };

    const roots = buildTree(state.events);
    const allTreeElements: React.ReactElement[] = [];
    roots.forEach((root, index) => {
        allTreeElements.push(...renderTree(root, 0, index === roots.length - 1));
    });

    const totalCount = state.events.length;

    return (
        <Box flexDirection="column" padding={1}>
            {/* Header */}
            <Box borderStyle="double" borderColor="cyan" paddingX={1} marginBottom={1}>
                <Text bold color="cyan">
                    🌐 Nostr Conversation Viewer (Live from Relays)
                </Text>
            </Box>

            {/* Event info */}
            <Box marginBottom={1}>
                <Text>
                    Root Event: <Text color="yellow">{state.rootEvent?.id?.substring(0, 16)}...</Text>
                </Text>
            </Box>

            <Box marginBottom={1}>
                <Text>
                    Total Events: <Text bold>{totalCount}</Text> | Participants: <Text bold>{state.participants.length}</Text>
                </Text>
            </Box>

            {/* Participant selector */}
            <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginBottom={1}>
                <Text bold>Select Participant (↑↓):</Text>
                {state.participants.map((participant, index) => {
                    const selected = index === state.selectedParticipantIndex;
                    const participantVisibleIds = state.visibilityMap.get(participant.pubkey) || new Set();
                    const percentage = participant.agent ? Math.round((participantVisibleIds.size / totalCount) * 100) : 100;
                    const role = participant.agent ? ` (${participant.agent.role})` : '';
                    const visibility = participant.agent ? ` - sees ${participantVisibleIds.size}/${totalCount} (${percentage}%)` : ' - all events';

                    return (
                        <Text key={participant.pubkey} color={selected ? 'green' : 'white'}>
                            {selected ? '→ ' : '  '}
                            {participant.name}{role}{visibility}
                        </Text>
                    );
                })}
            </Box>

            {/* Thread view */}
            <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1} marginBottom={1}>
                <Text bold color="green">
                    {selectedParticipant.name}'s View
                    {selectedParticipant.agent ? ` - ${visibleIds.size}/${totalCount} events` : ' - All Events'}
                </Text>
                {selectedParticipant.agent && (
                    <Text dimColor>Green = Visible | Gray = Filtered Out</Text>
                )}
                <Box flexDirection="column" marginTop={1}>
                    {allTreeElements}
                </Box>
            </Box>

            {/* Controls */}
            <Box borderStyle="single" borderColor="yellow" paddingX={1}>
                <Text>
                    <Text color="cyan">↑↓</Text> Select participant |{' '}
                    <Text color="red">Q/ESC</Text> Quit
                </Text>
            </Box>
        </Box>
    );
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.error('Usage: bun run nostr-conversation-viewer.tsx <event-id> [relay-urls...]');
        console.error('');
        console.error('Example:');
        console.error('  bun run nostr-conversation-viewer.tsx 1e19502b9d3febac577d3b7ce3bd5888c945b2261ff0480f45c870228bac4fde');
        console.error('  bun run nostr-conversation-viewer.tsx abc123 wss://relay1.com wss://relay2.com');
        process.exit(1);
    }

    const eventId = args[0];
    const relayUrls = args.slice(1);

    // Default to tenex.chat if no relays provided
    if (relayUrls.length === 0) {
        relayUrls.push('wss://tenex.chat');
    }

    console.log(`Event ID: ${eventId}`);
    console.log(`Relays: ${relayUrls.join(', ')}\n`);

    render(<NostrConversationViewer eventId={eventId} relayUrls={relayUrls} />);
}

if (import.meta.main) {
    main().catch(console.error);
}
