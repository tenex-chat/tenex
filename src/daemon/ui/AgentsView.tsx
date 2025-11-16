import React from "react";
import { Box, Text } from "ink";
import type { AgentInfo } from "./types";

interface AgentsViewProps {
  agents: AgentInfo[];
  selectedIndex: number;
}

export function AgentsView({ agents, selectedIndex }: AgentsViewProps): JSX.Element {
  if (agents.length === 0) {
    return (
      <Box>
        <Text dimColor>No agents found in this project</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {agents.map((agent, index) => {
        const isSelected = index === selectedIndex;

        return (
          <Box key={agent.pubkey} flexDirection="column" marginBottom={1}>
            <Text backgroundColor={isSelected ? "blue" : undefined} color={isSelected ? "white" : undefined}>
              {isSelected ? "▶ " : "  "}
              👤 {agent.name}
            </Text>
            <Text dimColor marginLeft={4}>
              Role: {agent.role}
            </Text>
            {agent.description && (
              <Text dimColor marginLeft={4}>
                {agent.description}
              </Text>
            )}
            <Text dimColor marginLeft={4}>
              Lessons: {agent.lessonsCount}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
