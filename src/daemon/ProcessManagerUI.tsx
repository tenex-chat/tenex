import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ProjectRuntime } from "./ProjectRuntime";
import { ConversationFetcher, type ConversationData } from "@/conversations/services/ConversationFetcher";
import { CONVERSATION_UI } from "@/conversations/constants";
import type { AgentInstance } from "@/agents/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { ProjectsView, type ProjectInfo } from "./ui/ProjectsView";
import { AgentsView, type AgentInfo } from "./ui/AgentsView";
import { AgentDetailView } from "./ui/AgentDetailView";
import { ConversationsView } from "./ui/ConversationsView";

interface ProcessManagerUIProps {
  runtimes: Map<string, ProjectRuntime>;
  onKill: (projectId: string) => Promise<void>;
  onRestart: (projectId: string) => Promise<void>;
  onClose: () => void;
}

type ActionType = "kill" | "restart";
type ViewMode = "projects" | "conversations" | "agents" | "agent-detail";

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

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentInstance | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentLessons, setAgentLessons] = useState<NDKAgentLesson[]>([]);

  useEffect((): (() => void) => {
    const updateProjects = (): void => {
      const newProjects = extractProjectInfo(runtimes);
      setProjects((prev) => {
        if (areProjectListsEqual(prev, newProjects)) {
          return prev;
        }
        return newProjects;
      });
    };

    updateProjects();
    const interval = setInterval(updateProjects, 1000);
    return () => clearInterval(interval);
  }, [runtimes]);

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

  useInput((input, key) => {
    if (statusMessage) {
      setStatusMessage("");
    }

    if (key.escape || key.backspace) {
      navigateBack();
      return;
    }

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

    if (viewMode === "projects") {
      if (input === "c") {
        setViewMode("conversations");
        setSelectedIndex(0);
      }

      if (input === "p") {
        setViewMode("projects");
        setSelectedIndex(0);
      }

      if (input === "k") {
        performAction("kill");
      }

      if (input === "r") {
        performAction("restart");
      }
    }
  });

  const getViewTitle = (): string => {
    switch (viewMode) {
      case "projects":
        return "[Projects]";
      case "conversations":
        return "[Conversations]";
      case "agents":
        return `[Agents - ${projects.find(p => p.projectId === selectedProjectId)?.title || ""}]`;
      case "agent-detail":
        return `[Agent Details - ${selectedAgent?.name || ""}]`;
      default:
        return "";
    }
  };

  const getInstructions = (): string => {
    switch (viewMode) {
      case "projects":
        return "Use ↑/↓ to navigate | Enter: expand | p: projects | c: conversations | k: kill | r: restart | q: quit";
      case "conversations":
        return "Use ↑/↓ to navigate | ESC: back to projects";
      case "agents":
        return "Use ↑/↓ to navigate | Enter: view details | ESC: back";
      case "agent-detail":
        return "ESC: back to agents";
      default:
        return "";
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">🚀 TENEX Process Manager</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{getInstructions()}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text bold color="green">{getViewTitle()}</Text>
      </Box>

      {viewMode === "projects" && <ProjectsView projects={projects} selectedIndex={selectedIndex} />}
      {viewMode === "conversations" && <ConversationsView conversations={conversations} selectedIndex={selectedIndex} />}
      {viewMode === "agents" && <AgentsView agents={agents} selectedIndex={selectedIndex} />}
      {viewMode === "agent-detail" && selectedAgent && <AgentDetailView agent={selectedAgent} lessons={agentLessons} />}

      {statusMessage && (
        <Box marginTop={1}>
          <Text color="yellow">{statusMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
