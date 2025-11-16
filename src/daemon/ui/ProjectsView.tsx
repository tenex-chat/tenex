import React from "react";
import { Box, Text } from "ink";
import { formatUptime } from "@/utils/time";
import type { ProjectInfo } from "./types";

interface ProjectsViewProps {
  projects: ProjectInfo[];
  selectedIndex: number;
}

export function ProjectsView({ projects, selectedIndex }: ProjectsViewProps): JSX.Element {
  if (projects.length === 0) {
    return (
      <Box>
        <Text dimColor>No running projects</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {projects.map((project, index) => {
        const isSelected = index === selectedIndex;
        const statusIcon = project.isRunning ? "🟢" : "🔴";

        return (
          <Box key={project.projectId}>
            <Text backgroundColor={isSelected ? "blue" : undefined} color={isSelected ? "white" : undefined}>
              {isSelected ? "▶ " : "  "}
              {statusIcon} {project.title}
            </Text>
            <Text dimColor>
              {" | "}
              Uptime: {formatUptime(project.startTime)}
              {" | "}
              Events: {project.eventCount}
              {" | "}
              Agents: {project.agentCount}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
