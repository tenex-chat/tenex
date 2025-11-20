import { formatTimeAgo } from "@/lib/time";
import { Box, Text } from "ink";
import React from "react";
import type { ConversationInfo } from "./types";

interface ConversationsViewProps {
    conversations: ConversationInfo[];
    selectedIndex: number;
}

export function ConversationsView({
    conversations,
    selectedIndex,
}: ConversationsViewProps): React.JSX.Element {
    if (conversations.length === 0) {
        return (
            <Box>
                <Text dimColor>No recent conversations</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column">
            {conversations.map((conv, index) => {
                const isSelected = index === selectedIndex;
                const timeAgo = formatTimeAgo(conv.lastActivity);

                return (
                    <Box key={conv.id} flexDirection="column" marginBottom={1}>
                        <Text
                            backgroundColor={isSelected ? "blue" : undefined}
                            color={isSelected ? "white" : undefined}
                        >
                            {isSelected ? "▶ " : "  "}💬 {conv.title}
                        </Text>
                        {conv.summary && (
                            <Box marginLeft={4}>
                                <Text dimColor>
                                    {conv.summary}
                                </Text>
                            </Box>
                        )}
                        <Box marginLeft={4}>
                            <Text dimColor>
                                Last activity: {timeAgo}
                            </Text>
                        </Box>
                    </Box>
                );
            })}
        </Box>
    );
}
