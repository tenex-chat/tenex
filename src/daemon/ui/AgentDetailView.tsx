import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { Box, Text } from "ink";
import React from "react";

interface AgentDetailViewProps {
    agent: AgentInstance;
    lessons: NDKAgentLesson[];
}

export function AgentDetailView({ agent, lessons }: AgentDetailViewProps): JSX.Element {
    return (
        <Box flexDirection="column">
            {/* Agent Info */}
            <Box marginBottom={1} flexDirection="column">
                <Text bold color="cyan">
                    Agent Information:
                </Text>
                <Text>Name: {agent.name}</Text>
                <Text>Role: {agent.role}</Text>
                {agent.description && <Text>Description: {agent.description}</Text>}
                <Text dimColor>Pubkey: {agent.pubkey.slice(0, 16)}...</Text>
            </Box>

            {/* System Prompt */}
            <Box marginBottom={1} flexDirection="column">
                <Text bold color="cyan">
                    System Instructions:
                </Text>
                {agent.instructions ? (
                    <Text wrap="wrap">{agent.instructions}</Text>
                ) : (
                    <Text dimColor>No instructions defined</Text>
                )}
            </Box>

            {/* Agent Lessons */}
            <Box flexDirection="column">
                <Text bold color="cyan">
                    Agent Lessons ({lessons.length}):
                </Text>
                {lessons.length === 0 ? (
                    <Text dimColor>No lessons loaded</Text>
                ) : (
                    <Box flexDirection="column" marginTop={1}>
                        {lessons.map((lesson, index) => (
                            <Box key={index} flexDirection="column" marginBottom={1}>
                                <Text bold>
                                    {index + 1}. {lesson.title || "Untitled Lesson"}
                                </Text>
                                <Text wrap="wrap" marginLeft={2}>
                                    {lesson.lesson}
                                </Text>
                                {lesson.detailed && (
                                    <Text dimColor wrap="wrap" marginLeft={2}>
                                        Details: {lesson.detailed}
                                    </Text>
                                )}
                                {lesson.category && (
                                    <Text dimColor marginLeft={2}>
                                        Category: {lesson.category}
                                    </Text>
                                )}
                            </Box>
                        ))}
                    </Box>
                )}
            </Box>
        </Box>
    );
}
