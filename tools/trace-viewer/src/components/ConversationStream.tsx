import { Box, Text, useInput, useStdout } from "ink";
import React, { useState, useMemo } from "react";
import type { Conversation, StreamItem, StreamItemType } from "../types.js";

interface ConversationStreamProps {
    conversation: Conversation;
    items: StreamItem[];
    onBack: () => void;
    onNextConversation?: () => void;
    onPrevConversation?: () => void;
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function getItemIcon(type: StreamItemType): string {
    switch (type) {
        case "received":
            return "←";
        case "routed":
            return "→";
        case "llm":
            return "🧠";
        case "tool":
            return "🔧";
        case "delegated":
            return "→";
        case "delegate_response":
            return "←";
        case "replied":
            return "✉️";
        case "error":
            return "❌";
        default:
            return "•";
    }
}

function getItemColor(type: StreamItemType): string {
    switch (type) {
        case "received":
            return "cyan";
        case "routed":
            return "blue";
        case "llm":
            return "magenta";
        case "tool":
            return "green";
        case "delegated":
            return "yellow";
        case "delegate_response":
            return "yellow";
        case "replied":
            return "cyan";
        case "error":
            return "red";
        default:
            return "white";
    }
}

function getItemAction(type: StreamItemType): string {
    switch (type) {
        case "received":
            return "received";
        case "routed":
            return "routed";
        case "llm":
            return "llm";
        case "tool":
            return "tool";
        case "delegated":
            return "delegated";
        case "delegate_response":
            return "delegate";
        case "replied":
            return "replied";
        case "error":
            return "error";
        default:
            return "unknown";
    }
}

export function ConversationStream({
    conversation,
    items,
    onBack,
    onNextConversation,
    onPrevConversation,
}: ConversationStreamProps) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
    const { stdout } = useStdout();

    // Calculate visible window - reserve 7 lines for header, metadata, and footer
    const terminalHeight = stdout?.rows || 24;
    const headerLines = 7;
    const availableLines = Math.max(5, terminalHeight - headerLines);

    // Calculate window of visible items based on selection
    const { visibleItems, startIndex } = useMemo(() => {
        if (items.length === 0) {
            return { visibleItems: [], startIndex: 0 };
        }

        // Keep selected item roughly in the middle of the visible area
        const halfWindow = Math.floor(availableLines / 2);
        let start = Math.max(0, selectedIndex - halfWindow);
        const end = Math.min(items.length, start + availableLines);

        // Adjust start if we're near the end
        if (end === items.length) {
            start = Math.max(0, items.length - availableLines);
        }

        return {
            visibleItems: items.slice(start, end),
            startIndex: start,
        };
    }, [items, selectedIndex, availableLines]);

    useInput((input, key) => {
        if (input === "q") {
            process.exit(0);
        } else if (key.escape || input === "b") {
            onBack();
        } else if (input === "n" && onNextConversation) {
            onNextConversation();
        } else if (input === "p" && onPrevConversation) {
            onPrevConversation();
        } else if (key.upArrow) {
            setSelectedIndex(Math.max(0, selectedIndex - 1));
        } else if (key.downArrow) {
            setSelectedIndex(Math.min(items.length - 1, selectedIndex + 1));
        } else if (key.return) {
            // Toggle expansion
            setExpandedItems((prev) => {
                const next = new Set(prev);
                if (next.has(selectedIndex)) {
                    next.delete(selectedIndex);
                } else {
                    next.add(selectedIndex);
                }
                return next;
            });
        } else if (input === "e") {
            // Expand all
            setExpandedItems(new Set(items.map((_, i) => i)));
        } else if (input === "c") {
            // Collapse all
            setExpandedItems(new Set());
        }
    });

    const relativeTime = formatRelativeTime(conversation.timestamp);

    return (
        <Box flexDirection="column" height={terminalHeight}>
            <Box borderStyle="single" borderColor="cyan" paddingX={1}>
                <Text bold color="cyan">
                    Conversation:
                </Text>
                <Text> "{conversation.firstMessage}"</Text>
                <Text dimColor> {conversation.messageCount} msgs</Text>
            </Box>

            <Box paddingX={1}>
                <Text dimColor>
                    Started {relativeTime}
                    {conversation.agents.length > 0 && (
                        <Text> | Agents: {conversation.agents.join(", ")}</Text>
                    )}
                </Text>
            </Box>

            {/* Scroll indicator */}
            {startIndex > 0 && (
                <Box paddingX={1}>
                    <Text dimColor>↑ {startIndex} more above</Text>
                </Box>
            )}

            <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {items.length === 0 ? (
                    <Box paddingX={2}>
                        <Text dimColor>No items found for this conversation.</Text>
                    </Box>
                ) : (
                    visibleItems.map((item, visibleIdx) => {
                        const actualIdx = startIndex + visibleIdx;
                        const isSelected = actualIdx === selectedIndex;
                        const isExpanded = expandedItems.has(actualIdx);
                        const icon = getItemIcon(item.type);
                        const color = getItemColor(item.type);
                        const action = getItemAction(item.type);
                        const timeStr = formatTime(item.timestamp);

                        return (
                            <Box key={actualIdx} flexDirection="column">
                                <Box>
                                    <Text backgroundColor={isSelected ? "blue" : undefined}>
                                        <Text dimColor>{timeStr}</Text>
                                        <Text>  </Text>
                                        <Text>{icon}</Text>
                                        <Text> </Text>
                                        <Text color={color}>{action.padEnd(10)}</Text>
                                        <Text> </Text>
                                        <Text>{item.preview}</Text>
                                    </Text>
                                </Box>

                                {isExpanded && item.details && (
                                    <ItemDetails item={item} />
                                )}
                            </Box>
                        );
                    })
                )}
            </Box>

            {/* Scroll indicator */}
            {startIndex + visibleItems.length < items.length && (
                <Box paddingX={1}>
                    <Text dimColor>↓ {items.length - startIndex - visibleItems.length} more below</Text>
                </Box>
            )}

            <Box borderStyle="single" borderColor="gray" paddingX={1}>
                <Text dimColor>
                    <Text color="cyan">↑↓</Text> navigate
                    <Text> </Text>
                    <Text color="cyan">Enter</Text> expand/collapse
                    <Text> </Text>
                    <Text color="cyan">e/c</Text> expand/collapse all
                    <Text> </Text>
                    <Text color="cyan">n/p</Text> next/prev conversation
                    <Text> </Text>
                    <Text color="cyan">Esc</Text> back
                    <Text> </Text>
                    <Text dimColor>({selectedIndex + 1}/{items.length})</Text>
                </Text>
            </Box>
        </Box>
    );
}

function ItemDetails({ item }: { item: StreamItem }) {
    const details = item.details;
    if (!details) return null;

    return (
        <Box flexDirection="column" marginLeft={12} marginBottom={1}>
            {details.duration !== undefined && (
                <Box>
                    <Text dimColor>├─ duration: </Text>
                    <Text color="yellow">{details.duration}ms</Text>
                </Box>
            )}
            {details.model && (
                <Box>
                    <Text dimColor>├─ model: </Text>
                    <Text color="magenta">{details.model}</Text>
                </Box>
            )}
            {details.tokens && (
                <Box>
                    <Text dimColor>├─ tokens: </Text>
                    <Text color="cyan">{details.tokens.input} in / {details.tokens.output} out</Text>
                </Box>
            )}
            {details.toolName && (
                <Box>
                    <Text dimColor>├─ tool: </Text>
                    <Text color="green">{details.toolName}</Text>
                </Box>
            )}
            {details.toolArgs && (
                <Box flexDirection="column">
                    <Text dimColor>├─ args:</Text>
                    {Object.entries(details.toolArgs).slice(0, 5).map(([key, value]) => {
                        const strValue = typeof value === "string" ? value : JSON.stringify(value);
                        const displayValue = strValue.length > 60
                            ? strValue.substring(0, 60) + "..."
                            : strValue;
                        return (
                            <Box key={key} marginLeft={3}>
                                <Text dimColor>  {key}: </Text>
                                <Text color="white">{displayValue}</Text>
                            </Box>
                        );
                    })}
                </Box>
            )}
            {details.toolResult && (
                <Box>
                    <Text dimColor>├─ result: </Text>
                    <Text color="white">
                        {details.toolResult.length > 60
                            ? details.toolResult.substring(0, 60) + "..."
                            : details.toolResult}
                    </Text>
                </Box>
            )}
            {details.error && (
                <Box>
                    <Text dimColor>└─ error: </Text>
                    <Text color="red">{details.error}</Text>
                </Box>
            )}
            {item.eventId && (
                <Box>
                    <Text dimColor>└─ eventId: </Text>
                    <Text color="gray">{item.eventId.substring(0, 16)}...</Text>
                </Box>
            )}
        </Box>
    );
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
