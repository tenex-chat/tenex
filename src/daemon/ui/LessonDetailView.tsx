import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { Box, Text } from "ink";
import React from "react";

interface LessonDetailViewProps {
    lesson: NDKAgentLesson;
}

export function LessonDetailView({ lesson }: LessonDetailViewProps): JSX.Element {
    return (
        <Box flexDirection="column">
            <Box marginBottom={1} flexDirection="column">
                <Text bold color="cyan">
                    {lesson.title || "Untitled Lesson"}
                </Text>
                {lesson.category && (
                    <Text dimColor>Category: {lesson.category}</Text>
                )}
            </Box>

            <Box marginBottom={1} flexDirection="column">
                <Text bold color="green">
                    Lesson:
                </Text>
                <Text wrap="wrap">{lesson.lesson}</Text>
            </Box>

            {lesson.detailed && (
                <Box marginBottom={1} flexDirection="column">
                    <Text bold color="green">
                        Details:
                    </Text>
                    <Text wrap="wrap">{lesson.detailed}</Text>
                </Box>
            )}

            {lesson.hashtags && lesson.hashtags.length > 0 && (
                <Box flexDirection="column">
                    <Text bold color="green">
                        Tags:
                    </Text>
                    <Text dimColor>{lesson.hashtags.join(", ")}</Text>
                </Box>
            )}
        </Box>
    );
}
