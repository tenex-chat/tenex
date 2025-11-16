import React from "react";
import { Box, Text } from "ink";
import { formatTimeAgo } from "@/utils/time";
import type { ConversationInfo } from "./types";

interface ConversationsViewProps {
  conversations: ConversationInfo[];
  selectedIndex: number;
}

export function ConversationsView({ conversations, selectedIndex }: ConversationsViewProps): JSX.Element {
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
            <Text backgroundColor={isSelected ? "blue" : undefined} color={isSelected ? "white" : undefined}>
              {isSelected ? "▶ " : "  "}
              💬 {conv.title}
            </Text>
            {conv.summary && (
              <Text dimColor marginLeft={4}>
                {conv.summary}
              </Text>
            )}
            <Text dimColor marginLeft={4}>
              Last activity: {timeAgo}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
