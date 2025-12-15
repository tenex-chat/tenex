import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import React, { useState, useMemo } from "react";
import type { Conversation } from "../types.js";

interface ConversationListProps {
    conversations: Conversation[];
    onSelect: (conversation: Conversation) => void;
    onJumpToEvent: (eventId: string) => void;
    onRefresh: () => void;
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ago`;
    } else if (minutes > 0) {
        return `${minutes}m ago`;
    } else {
        return `${seconds}s ago`;
    }
}

export function ConversationList({
    conversations,
    onSelect,
    onJumpToEvent,
    onRefresh,
}: ConversationListProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchMode, setSearchMode] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const { stdout } = useStdout();

    // Calculate visible window - reserve 6 lines for header, title, and footer
    const terminalHeight = stdout?.rows || 24;
    const headerLines = 6;
    const availableLines = Math.max(5, terminalHeight - headerLines);

    // Calculate window of visible items based on selection
    const { visibleItems, startIndex } = useMemo(() => {
        if (conversations.length === 0) {
            return { visibleItems: [], startIndex: 0 };
        }

        const halfWindow = Math.floor(availableLines / 2);
        let start = Math.max(0, selectedIndex - halfWindow);
        const end = Math.min(conversations.length, start + availableLines);

        if (end === conversations.length) {
            start = Math.max(0, conversations.length - availableLines);
        }

        return {
            visibleItems: conversations.slice(start, end),
            startIndex: start,
        };
    }, [conversations, selectedIndex, availableLines]);

    useInput((input, key) => {
        if (searchMode) {
            if (key.escape) {
                setSearchMode(false);
                setSearchQuery("");
            } else if (key.return && searchQuery.trim()) {
                onJumpToEvent(searchQuery.trim());
                setSearchMode(false);
                setSearchQuery("");
            }
            return;
        }

        if (input === "q") {
            process.exit(0);
        } else if (input === "r") {
            onRefresh();
        } else if (input === "/") {
            setSearchMode(true);
        } else if (key.upArrow) {
            setSelectedIndex(Math.max(0, selectedIndex - 1));
        } else if (key.downArrow) {
            setSelectedIndex(Math.min(conversations.length - 1, selectedIndex + 1));
        } else if (key.return) {
            if (conversations[selectedIndex]) {
                onSelect(conversations[selectedIndex]);
            }
        }
    });

    if (searchMode) {
        return (
            <Box flexDirection="column" height={terminalHeight}>
                <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                    <Text bold color="cyan">
                        Jump to Event ID
                    </Text>
                </Box>
                <Box marginTop={1} paddingX={2}>
                    <Text>Event ID: </Text>
                    <TextInput
                        value={searchQuery}
                        onChange={setSearchQuery}
                        placeholder="paste event id..."
                    />
                </Box>
                <Box marginTop={1} paddingX={2}>
                    <Text dimColor>Enter to search, Esc to cancel</Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" height={terminalHeight}>
            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text bold color="cyan">
                    TENEX Trace Viewer
                </Text>
                <Text dimColor> - [r]efresh [/]jump to event [q]uit</Text>
            </Box>

            <Box marginTop={1} paddingX={1}>
                <Text bold>Recent Conversations ({conversations.length})</Text>
            </Box>

            {startIndex > 0 && (
                <Box paddingX={1}>
                    <Text dimColor>↑ {startIndex} more above</Text>
                </Box>
            )}

            <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {conversations.length === 0 ? (
                    <Box paddingX={2}>
                        <Text dimColor>No conversations found. Make sure Jaeger is running.</Text>
                    </Box>
                ) : (
                    visibleItems.map((conv, visibleIdx) => {
                        const actualIdx = startIndex + visibleIdx;
                        const isSelected = actualIdx === selectedIndex;
                        const timeStr = formatRelativeTime(conv.timestamp);

                        return (
                            <Box key={conv.id} paddingX={1}>
                                <Text backgroundColor={isSelected ? "blue" : undefined}>
                                    <Text>{isSelected ? "> " : "  "}</Text>
                                    <Text dimColor>{timeStr.padEnd(8)}</Text>
                                    <Text> </Text>
                                    <Text color="white">"{conv.firstMessage}"</Text>
                                    <Text dimColor> </Text>
                                    <Text color="yellow">{conv.messageCount} msgs</Text>
                                </Text>
                            </Box>
                        );
                    })
                )}
            </Box>

            {startIndex + visibleItems.length < conversations.length && (
                <Box paddingX={1}>
                    <Text dimColor>↓ {conversations.length - startIndex - visibleItems.length} more below</Text>
                </Box>
            )}

            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>
                    <Text color="cyan">↑↓</Text> navigate
                    <Text> </Text>
                    <Text color="cyan">Enter</Text> view
                    <Text> </Text>
                    <Text color="cyan">/</Text> jump to event ID
                    <Text> </Text>
                    <Text dimColor>({selectedIndex + 1}/{conversations.length})</Text>
                </Text>
            </Box>
        </Box>
    );
}
