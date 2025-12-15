import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import React, { useState, useEffect, useMemo } from "react";
import { JaegerClient } from "../services/JaegerClient.js";
import type { Conversation, StreamItem } from "../types.js";
import { ConversationList } from "./ConversationList.js";
import { ConversationStream } from "./ConversationStream.js";

type ViewState = "conversations" | "stream";

interface AppProps {
    jaegerUrl?: string;
    serviceName?: string;
}

export function App({
    jaegerUrl = "http://localhost:16686",
    serviceName = "tenex-daemon",
}: AppProps) {
    const [view, setView] = useState<ViewState>("conversations");
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
    const [currentConversationIndex, setCurrentConversationIndex] = useState(0);
    const [streamItems, setStreamItems] = useState<StreamItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | undefined>();

    const jaegerClient = useMemo(() => new JaegerClient(jaegerUrl), [jaegerUrl]);

    // Load conversations on mount
    useEffect(() => {
        loadConversations();
    }, []);

    const loadConversations = async () => {
        setLoading(true);
        setError(undefined);
        try {
            const fetchedConversations = await jaegerClient.getConversations(serviceName, 50);
            setConversations(fetchedConversations);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const handleSelectConversation = async (conversation: Conversation) => {
        setLoading(true);
        setError(undefined);
        try {
            const items = await jaegerClient.getConversationStream(conversation.id, serviceName);
            setStreamItems(items);
            setCurrentConversation(conversation);
            setCurrentConversationIndex(conversations.findIndex((c) => c.id === conversation.id));
            setView("stream");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const handleJumpToEvent = async (eventId: string) => {
        setLoading(true);
        setError(undefined);
        try {
            // Try to fetch conversation stream for this event ID
            const items = await jaegerClient.getConversationStream(eventId, serviceName);

            if (items.length === 0) {
                setError(`No traces found for event ID: ${eventId}`);
                setLoading(false);
                return;
            }

            // Create a synthetic conversation for display
            const syntheticConversation: Conversation = {
                id: eventId,
                firstMessage: items[0]?.preview || "Unknown",
                timestamp: items[0]?.timestamp || Date.now(),
                messageCount: items.length,
                agents: [...new Set(items.map((i) => i.agent).filter((a) => a !== "unknown"))],
            };

            setStreamItems(items);
            setCurrentConversation(syntheticConversation);
            setCurrentConversationIndex(-1); // Not in the list
            setView("stream");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    };

    const handleBack = () => {
        setView("conversations");
        setCurrentConversation(null);
        setStreamItems([]);
    };

    const handleNextConversation = async () => {
        if (currentConversationIndex < conversations.length - 1) {
            const nextConv = conversations[currentConversationIndex + 1];
            await handleSelectConversation(nextConv);
        }
    };

    const handlePrevConversation = async () => {
        if (currentConversationIndex > 0) {
            const prevConv = conversations[currentConversationIndex - 1];
            await handleSelectConversation(prevConv);
        }
    };

    // Loading state
    if (loading) {
        return (
            <Box flexDirection="column">
                <Box borderStyle="single" borderColor="gray" paddingX={1}>
                    <Text bold color="cyan">
                        TENEX Trace Viewer
                    </Text>
                    <Text dimColor> - Loading...</Text>
                </Box>
                <Box marginTop={1} paddingX={2}>
                    <Text color="green">
                        <Spinner type="dots" />
                    </Text>
                    <Text> Loading from Jaeger...</Text>
                </Box>
            </Box>
        );
    }

    // Error state (only show if no data at all)
    if (error && conversations.length === 0 && !currentConversation) {
        return (
            <Box flexDirection="column">
                <Box borderStyle="single" borderColor="red" paddingX={1}>
                    <Text bold color="red">
                        Error
                    </Text>
                </Box>
                <Box marginTop={1} paddingX={2} flexDirection="column">
                    <Text color="red">Failed to load:</Text>
                    <Text color="red">{error}</Text>
                    <Box marginTop={1}>
                        <Text dimColor>Press 'r' to retry, 'q' to quit</Text>
                    </Box>
                </Box>
            </Box>
        );
    }

    // Conversations list view
    if (view === "conversations") {
        return (
            <ConversationList
                conversations={conversations}
                onSelect={handleSelectConversation}
                onJumpToEvent={handleJumpToEvent}
                onRefresh={loadConversations}
            />
        );
    }

    // Conversation stream view
    if (view === "stream" && currentConversation) {
        return (
            <ConversationStream
                conversation={currentConversation}
                items={streamItems}
                onBack={handleBack}
                onNextConversation={
                    currentConversationIndex >= 0 && currentConversationIndex < conversations.length - 1
                        ? handleNextConversation
                        : undefined
                }
                onPrevConversation={
                    currentConversationIndex > 0 ? handlePrevConversation : undefined
                }
            />
        );
    }

    return null;
}
