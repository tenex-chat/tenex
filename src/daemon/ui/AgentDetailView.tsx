import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { Box, Text } from "ink";
import React from "react";

interface AgentDetailViewProps {
    agent: AgentInstance;
    lessons: NDKAgentLesson[];
    selectedIndex: number;
}

export function AgentDetailView({ agent, lessons, selectedIndex }: AgentDetailViewProps): JSX.Element {
    const instructionsLength = agent.instructions?.length || 0;

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
                <Text dimColor>Pubkey: {agent.pubkey}</Text>
            </Box>

            {/* Selectable Items */}
            <Box flexDirection="column">
                <Text bold color="cyan" marginBottom={1}>
                    Details:
                </Text>

                {/* System Prompt - First selectable item */}
                <Text
                    backgroundColor={selectedIndex === 0 ? "blue" : undefined}
                    color={selectedIndex === 0 ? "white" : undefined}
                >
                    {selectedIndex === 0 ? "▶ " : "  "}
                    System Instructions ({instructionsLength} chars)
                </Text>

                {/* Lessons */}
                {lessons.length === 0 ? (
                    <Text dimColor marginTop={1}>
                        No lessons loaded
                    </Text>
                ) : (
                    <Box flexDirection="column" marginTop={1}>
                        {lessons.map((lesson, lessonIndex) => {
                            const itemIndex = lessonIndex + 1; // +1 because index 0 is system prompt
                            const isSelected = itemIndex === selectedIndex;
                            return (
                                <Text
                                    key={lessonIndex}
                                    backgroundColor={isSelected ? "blue" : undefined}
                                    color={isSelected ? "white" : undefined}
                                >
                                    {isSelected ? "▶ " : "  "}
                                    {lessonIndex + 1}. {lesson.title || "Untitled Lesson"}
                                    {lesson.category ? ` [${lesson.category}]` : ""}
                                </Text>
                            );
                        })}
                    </Box>
                )}
            </Box>
        </Box>
    );
}
