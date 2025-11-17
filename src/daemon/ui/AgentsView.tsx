import { Box, Text } from "ink";
import React from "react";
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
                    <Text
                        key={agent.pubkey}
                        backgroundColor={isSelected ? "blue" : undefined}
                        color={isSelected ? "white" : undefined}
                    >
                        {isSelected ? "▶ " : "  "}👤 {agent.name} ({agent.lessonsCount} lessons)
                    </Text>
                );
            })}
        </Box>
    );
}
