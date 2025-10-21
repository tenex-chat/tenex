import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { ProjectRuntime } from "./ProjectRuntime";

interface ProcessManagerUIProps {
  runtimes: Map<string, ProjectRuntime>;
  onKill: (projectId: string) => Promise<void>;
  onRestart: (projectId: string) => Promise<void>;
  onClose: () => void;
}

interface ProjectInfo {
  projectId: string;
  title: string;
  isRunning: boolean;
  startTime: Date | null;
  eventCount: number;
  agentCount: number;
}

type ActionType = "kill" | "restart";

/**
 * Format uptime from a start time
 */
function formatUptime(startTime: Date | null): string {
  if (!startTime) return "N/A";
  const now = new Date();
  const diff = now.getTime() - startTime.getTime();
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Check if two project lists are equivalent (shallow comparison of key fields)
 */
function areProjectListsEqual(a: ProjectInfo[], b: ProjectInfo[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    const projA = a[i];
    const projB = b[i];
    if (
      projA.projectId !== projB.projectId ||
      projA.title !== projB.title ||
      projA.isRunning !== projB.isRunning ||
      projA.eventCount !== projB.eventCount ||
      projA.agentCount !== projB.agentCount ||
      projA.startTime?.getTime() !== projB.startTime?.getTime()
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Extract project info from runtimes
 */
function extractProjectInfo(runtimes: Map<string, ProjectRuntime>): ProjectInfo[] {
  const projectList: ProjectInfo[] = [];

  for (const [projectId, runtime] of runtimes) {
    const status = runtime.getStatus();
    projectList.push({
      projectId,
      title: status.title,
      isRunning: status.isRunning,
      startTime: status.startTime,
      eventCount: status.eventCount,
      agentCount: status.agentCount,
    });
  }

  return projectList;
}

export function ProcessManagerUI({ runtimes, onKill, onRestart, onClose }: ProcessManagerUIProps) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [statusMessage, setStatusMessage] = useState<string>("");

  // Update project list only when data actually changes
  useEffect(() => {
    const updateProjects = () => {
      const newProjects = extractProjectInfo(runtimes);

      // Only update state if the project list has actually changed
      setProjects((prev) => {
        if (areProjectListsEqual(prev, newProjects)) {
          return prev; // No change, return previous state to avoid re-render
        }
        return newProjects;
      });
    };

    updateProjects();
    const interval = setInterval(updateProjects, 1000); // Update every second

    return () => clearInterval(interval);
  }, [runtimes]);

  // Helper: Handle navigation (up/down arrows)
  const handleNavigation = (direction: "up" | "down") => {
    if (direction === "up") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else {
      setSelectedIndex((prev) => Math.min(projects.length - 1, prev + 1));
    }
  };

  // Helper: Perform action (kill or restart) on selected project
  const performAction = async (action: ActionType) => {
    if (projects.length === 0) return;

    const project = projects[selectedIndex];
    if (!project) return;

    const actionVerb = action === "kill" ? "Killing" : "Restarting";
    const actionPastTense = action === "kill" ? "Killed" : "Restarted";

    setStatusMessage(`${actionVerb} ${project.title}...`);

    try {
      if (action === "kill") {
        await onKill(project.projectId);
      } else {
        await onRestart(project.projectId);
      }
      setStatusMessage(`${actionPastTense} ${project.title}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Failed to ${action} ${project.title}: ${errorMessage}`);
    }
  };

  // Input handler
  useInput((input, key) => {
    // Clear status message on any key
    if (statusMessage) {
      setStatusMessage("");
    }

    if (key.escape || input === "q") {
      onClose();
      return;
    }

    if (key.upArrow) {
      handleNavigation("up");
    }

    if (key.downArrow) {
      handleNavigation("down");
    }

    if (input === "k") {
      performAction("kill");
    }

    if (input === "r") {
      performAction("restart");
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🚀 TENEX Process Manager
        </Text>
      </Box>

      {/* Instructions */}
      <Box marginBottom={1}>
        <Text dimColor>Use ↑/↓ to navigate | k: kill | r: restart | q/ESC: close</Text>
      </Box>

      {/* Project List */}
      {projects.length === 0 ? (
        <Box>
          <Text dimColor>No running projects</Text>
        </Box>
      ) : (
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
      )}

      {/* Status Message */}
      {statusMessage && (
        <Box marginTop={1}>
          <Text color="yellow">{statusMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
