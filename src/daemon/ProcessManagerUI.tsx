import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ProjectRuntime } from "./ProjectRuntime";
import { ConversationFetcher, type ConversationData } from "@/conversations/services/ConversationFetcher";
import { CONVERSATION_UI } from "@/conversations/constants";
import { formatTimeAgo, formatUptime } from "@/utils/time";
import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";

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

interface AgentInfo {
  pubkey: string;
  name: string;
  role: string;
  description?: string;
  lessonsCount: number;
}

type ActionType = "kill" | "restart";
type ViewMode = "projects" | "conversations" | "agents" | "agent-detail";

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

export function ProcessManagerUI({ runtimes, onKill, onRestart, onClose }: ProcessManagerUIProps): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [conversations, setConversations] = useState<ConversationData[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("projects");
  const [statusMessage, setStatusMessage] = useState<string>("");

  // State for agent views
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentInstance | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentLessons, setAgentLessons] = useState<NDKAgentLesson[]>([]);

  // Update project list only when data actually changes
  useEffect((): (() => void) => {
    const updateProjects = (): void => {
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

  // Fetch conversations from Nostr
  useEffect((): (() => void) => {
    const fetchConversations = async (): Promise<void> => {
      try {
        const conversations = await ConversationFetcher.fetchRecentConversations();
        setConversations(conversations);
      } catch (error) {
        console.error("Failed to fetch conversations:", error);
      }
    };

    fetchConversations();
    const interval = setInterval(fetchConversations, CONVERSATION_UI.REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  // Helper: Load agents for a project
  const loadAgents = (projectId: string): void => {
    const runtime = runtimes.get(projectId);
    if (!runtime) {
      setStatusMessage("Project runtime not found");
      return;
    }

    const context = runtime.getContext();
    if (!context) {
      setStatusMessage("Project context not available");
      return;
    }

    const allAgents = context.agentRegistry.getAllAgents();
    const agentInfoList: AgentInfo[] = allAgents.map((agent) => {
      const lessons = context.getLessonsForAgent(agent.pubkey);
      return {
        pubkey: agent.pubkey,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        lessonsCount: lessons.length,
      };
    });

    setAgents(agentInfoList);
    setSelectedProjectId(projectId);
    setViewMode("agents");
    setSelectedIndex(0);
  };

  // Helper: Load agent details
  const loadAgentDetails = (agentPubkey: string): void => {
    if (!selectedProjectId) return;

    const runtime = runtimes.get(selectedProjectId);
    if (!runtime) return;

    const context = runtime.getContext();
    if (!context) return;

    const agent = context.agentRegistry.getAgentByPubkey(agentPubkey);
    if (!agent) {
      setStatusMessage("Agent not found");
      return;
    }

    const lessons = context.getLessonsForAgent(agentPubkey);
    setSelectedAgent(agent);
    setAgentLessons(lessons);
    setViewMode("agent-detail");
    setSelectedIndex(0);
  };

  // Helper: Navigate back
  const navigateBack = (): void => {
    if (viewMode === "agent-detail") {
      setViewMode("agents");
      setSelectedAgent(null);
      setAgentLessons([]);
      setSelectedIndex(0);
    } else if (viewMode === "agents") {
      setViewMode("projects");
      setSelectedProjectId(null);
      setAgents([]);
      setSelectedIndex(0);
    } else if (viewMode === "conversations") {
      setViewMode("projects");
      setSelectedIndex(0);
    } else {
      onClose();
    }
  };

  // Helper: Handle navigation (up/down arrows)
  const handleNavigation = (direction: "up" | "down"): void => {
    let maxIndex: number;
    switch (viewMode) {
      case "projects":
        maxIndex = projects.length - 1;
        break;
      case "conversations":
        maxIndex = conversations.length - 1;
        break;
      case "agents":
        maxIndex = agents.length - 1;
        break;
      case "agent-detail":
        // No navigation in detail view
        return;
      default:
        maxIndex = 0;
    }

    if (direction === "up") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else {
      setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
    }
  };

  // Helper: Perform action (kill or restart) on selected project
  const performAction = async (action: ActionType): Promise<void> => {
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

    // ESC or Backspace to navigate back
    if (key.escape || key.backspace) {
      navigateBack();
      return;
    }

    // q to quit (only from projects view)
    if (input === "q" && viewMode === "projects") {
      onClose();
      return;
    }

    if (key.upArrow) {
      handleNavigation("up");
    }

    if (key.downArrow) {
      handleNavigation("down");
    }

    // Enter to drill down
    if (key.return) {
      if (viewMode === "projects" && projects.length > 0) {
        const project = projects[selectedIndex];
        if (project) {
          loadAgents(project.projectId);
        }
      } else if (viewMode === "agents" && agents.length > 0) {
        const agent = agents[selectedIndex];
        if (agent) {
          loadAgentDetails(agent.pubkey);
        }
      }
      return;
    }

    // Switch view modes (only from projects view)
    if (viewMode === "projects") {
      if (input === "c") {
        setViewMode("conversations");
        setSelectedIndex(0);
      }

      if (input === "p") {
        setViewMode("projects");
        setSelectedIndex(0);
      }

      // Actions only work in projects view
      if (input === "k") {
        performAction("kill");
      }

      if (input === "r") {
        performAction("restart");
      }
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
        <Text dimColor>
          {viewMode === "projects" && "Use ↑/↓ to navigate | Enter: expand | p: projects | c: conversations | k: kill | r: restart | q: quit"}
          {viewMode === "conversations" && "Use ↑/↓ to navigate | ESC: back to projects"}
          {viewMode === "agents" && "Use ↑/↓ to navigate | Enter: view details | ESC: back"}
          {viewMode === "agent-detail" && "ESC: back to agents"}
        </Text>
      </Box>

      {/* View Mode Indicator */}
      <Box marginBottom={1}>
        <Text bold color="green">
          {viewMode === "projects" && "[Projects]"}
          {viewMode === "conversations" && "[Conversations]"}
          {viewMode === "agents" && `[Agents - ${projects.find(p => p.projectId === selectedProjectId)?.title || ""}]`}
          {viewMode === "agent-detail" && `[Agent Details - ${selectedAgent?.name || ""}]`}
        </Text>
      </Box>

      {/* Content based on view mode */}
      {viewMode === "projects" && (
        // Projects View
        projects.length === 0 ? (
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
        )
      )}

      {viewMode === "conversations" && (
        // Conversations View
        conversations.length === 0 ? (
          <Box>
            <Text dimColor>No recent conversations</Text>
          </Box>
        ) : (
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
        )
      )}

      {viewMode === "agents" && (
        // Agents View
        agents.length === 0 ? (
          <Box>
            <Text dimColor>No agents found in this project</Text>
          </Box>
        ) : (
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
        )
      )}

      {viewMode === "agent-detail" && selectedAgent && (
        // Agent Detail View
        <Box flexDirection="column">
          {/* Agent Info */}
          <Box marginBottom={1} flexDirection="column">
            <Text bold color="cyan">Agent Information:</Text>
            <Text>Name: {selectedAgent.name}</Text>
            <Text>Role: {selectedAgent.role}</Text>
            {selectedAgent.description && <Text>Description: {selectedAgent.description}</Text>}
            <Text dimColor>Pubkey: {selectedAgent.pubkey.slice(0, 16)}...</Text>
          </Box>

          {/* System Prompt */}
          <Box marginBottom={1} flexDirection="column">
            <Text bold color="cyan">System Instructions:</Text>
            {selectedAgent.instructions ? (
              <Text wrap="wrap">{selectedAgent.instructions}</Text>
            ) : (
              <Text dimColor>No instructions defined</Text>
            )}
          </Box>

          {/* Agent Lessons */}
          <Box flexDirection="column">
            <Text bold color="cyan">Agent Lessons ({agentLessons.length}):</Text>
            {agentLessons.length === 0 ? (
              <Text dimColor>No lessons loaded</Text>
            ) : (
              <Box flexDirection="column" marginTop={1}>
                {agentLessons.map((lesson, index) => (
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
