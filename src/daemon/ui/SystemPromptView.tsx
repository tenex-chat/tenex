import type { AgentInstance } from "@/agents/types";
import { Box, Text } from "ink";
import React from "react";

interface SystemPromptViewProps {
    agent: AgentInstance;
}

export function SystemPromptView({ agent }: SystemPromptViewProps): JSX.Element {
    return (
        <Box flexDirection="column">
            <Box marginBottom={1}>
                <Text bold color="cyan">
                    System Instructions for {agent.name}:
                </Text>
            </Box>

            <Box flexDirection="column">
                {agent.instructions ? (
                    <Text wrap="wrap">{agent.instructions}</Text>
                ) : (
                    <Text dimColor>No instructions defined</Text>
                )}
            </Box>
        </Box>
    );
}
