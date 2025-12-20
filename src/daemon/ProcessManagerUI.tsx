import type { NDKProject } from "@nostr-dev-kit/ndk";
import { Box, Text, useInput } from "ink";
import React, { useState, useEffect, useReducer } from "react";
import type { ProjectRuntime } from "./ProjectRuntime";
import { AgentDetailView } from "./ui/AgentDetailView";
import { AgentsView } from "./ui/AgentsView";
import { ConversationsView } from "./ui/ConversationsView";
import { LessonDetailView } from "./ui/LessonDetailView";
import { ProjectsView } from "./ui/ProjectsView";
import { SystemPromptView } from "./ui/SystemPromptView";
import { initialViewState, viewReducer } from "./ui/state";
import type { ActionType, ConversationInfo, ProjectInfo } from "./ui/types";
import { areProjectListsEqual, extractCachedConversations, extractProjectInfo } from "./ui/utils";
import { VIEW_INSTRUCTIONS, getViewTitle } from "./ui/viewConfig";

interface ProcessManagerUIProps {
    knownProjects: Map<string, NDKProject>;
    runtimes: Map<string, ProjectRuntime>;
    onStart: (projectId: string) => Promise<void>;
    onKill: (projectId: string) => Promise<void>;
    onRestart: (projectId: string) => Promise<void>;
    onClose: () => void;
}

export function ProcessManagerUI({
    knownProjects,
    runtimes,
    onStart,
    onKill,
    onRestart,
    onClose,
}: ProcessManagerUIProps): React.JSX.Element {
    const [viewState, dispatch] = useReducer(viewReducer, initialViewState);
    const [projects, setProjects] = useState<ProjectInfo[]>([]);
    const [conversations, setConversations] = useState<ConversationInfo[]>([]);
    const [filterText, setFilterText] = useState<string>("");

    useEffect((): (() => void) => {
        const updateProjects = (): void => {
            const newProjects = extractProjectInfo(knownProjects, runtimes);
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
    }, [knownProjects, runtimes]);

    useEffect((): (() => void) => {
        const updateConversations = (): void => {
            const cachedConversations = extractCachedConversations(runtimes);
            setConversations(cachedConversations);
        };

        updateConversations();
        const interval = setInterval(updateConversations, 2000);
        return () => clearInterval(interval);
    }, [runtimes]);

    // Filter projects when in projects view
    const filteredProjects =
        viewState.viewMode === "projects" && filterText
            ? projects.filter((p) => p.title.toLowerCase().includes(filterText.toLowerCase()))
            : projects;

    // Reset selection when filter changes cause index to go out of bounds
    useEffect(() => {
        if (
            viewState.viewMode === "projects" &&
            viewState.selectedIndex >= filteredProjects.length &&
            filteredProjects.length > 0
        ) {
            dispatch({ type: "NAVIGATE", direction: "up", maxIndex: filteredProjects.length - 1 });
        }
    }, [filteredProjects.length, viewState.selectedIndex, viewState.viewMode]);

    const loadAgents = (projectId: string): void => {
        try {
            const runtime = runtimes.get(projectId);
            if (!runtime) {
                dispatch({ type: "SET_STATUS", message: "Error: Project runtime not found" });
                return;
            }

            const context = runtime.getContext();
            if (!context) {
                dispatch({
                    type: "SET_STATUS",
                    message:
                        "Error: Project context not available - project may still be initializing",
                });
                return;
            }

            const allAgents = context.agentRegistry?.getAllAgents();
            if (!allAgents) {
                dispatch({ type: "SET_STATUS", message: "Error: Agent registry not available" });
                return;
            }

            const agentInfoList = allAgents.map((agent) => {
                const lessons = context.getLessonsForAgent?.(agent.pubkey) || [];
                return {
                    pubkey: agent.pubkey,
                    name: agent.name,
                    role: agent.role,
                    description: agent.description,
                    lessonsCount: lessons.length,
                };
            });

            dispatch({ type: "VIEW_AGENTS", projectId, agents: agentInfoList });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            dispatch({ type: "SET_STATUS", message: `Error loading agents: ${errorMessage}` });
        }
    };

    const loadAgentDetails = (agentPubkey: string): void => {
        try {
            if (!viewState.selectedProjectId) {
                dispatch({ type: "SET_STATUS", message: "Error: No project selected" });
                return;
            }

            const runtime = runtimes.get(viewState.selectedProjectId);
            if (!runtime) {
                dispatch({ type: "SET_STATUS", message: "Error: Project runtime not found" });
                return;
            }

            const context = runtime.getContext();
            if (!context) {
                dispatch({ type: "SET_STATUS", message: "Error: Project context not available" });
                return;
            }

            const agent = context.agentRegistry?.getAgentByPubkey(agentPubkey);
            if (!agent) {
                dispatch({ type: "SET_STATUS", message: "Error: Agent not found in registry" });
                return;
            }

            const lessons = context.getLessonsForAgent?.(agentPubkey) || [];
            dispatch({ type: "VIEW_AGENT_DETAIL", agent, lessons });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            dispatch({
                type: "SET_STATUS",
                message: `Error loading agent details: ${errorMessage}`,
            });
        }
    };

    const navigateBack = (): void => {
        if (viewState.viewMode === "projects") {
            if (filterText) {
                // Clear filter first if there is one
                setFilterText("");
            } else {
                onClose();
            }
        } else {
            dispatch({ type: "NAVIGATE_BACK" });
        }
    };

    const handleNavigation = (direction: "up" | "down"): void => {
        let maxIndex: number;
        switch (viewState.viewMode) {
            case "projects":
                maxIndex = filteredProjects.length - 1;
                break;
            case "conversations":
                maxIndex = conversations.length - 1;
                break;
            case "agents":
                maxIndex = viewState.agents.length - 1;
                break;
            case "agent-detail":
                // 1 for system prompt + lessons
                maxIndex = viewState.agentLessons.length;
                break;
            case "lesson-detail":
            case "system-prompt":
                return;
            default:
                maxIndex = 0;
        }

        dispatch({ type: "NAVIGATE", direction, maxIndex });
    };

    const performStart = async (projectId: string, title: string): Promise<void> => {
        dispatch({ type: "SET_STATUS", message: `Starting ${title}...` });

        try {
            await onStart(projectId);
            // Auto-close the project list after successful start
            onClose();
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            dispatch({
                type: "SET_STATUS",
                message: `Failed to start ${title}: ${errorMessage}`,
            });
        }
    };

    const performAction = async (action: ActionType): Promise<void> => {
        if (filteredProjects.length === 0) return;

        const project = filteredProjects[viewState.selectedIndex];
        if (!project) return;

        const actionVerb = action === "kill" ? "Killing" : "Restarting";
        const actionPastTense = action === "kill" ? "Killed" : "Restarted";

        dispatch({ type: "SET_STATUS", message: `${actionVerb} ${project.title}...` });

        try {
            if (action === "kill") {
                await onKill(project.projectId);
            } else {
                await onRestart(project.projectId);
            }
            dispatch({ type: "SET_STATUS", message: `${actionPastTense} ${project.title}` });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            dispatch({
                type: "SET_STATUS",
                message: `Failed to ${action} ${project.title}: ${errorMessage}`,
            });
        }
    };

    useInput((input, key) => {
        if (viewState.statusMessage) {
            dispatch({ type: "CLEAR_STATUS" });
        }

        if (key.escape) {
            navigateBack();
            return;
        }

        // Handle backspace for filter or navigation
        if (key.backspace) {
            if (viewState.viewMode === "projects" && filterText) {
                setFilterText((prev) => prev.slice(0, -1));
            } else {
                navigateBack();
            }
            return;
        }

        if (input === "q" && viewState.viewMode === "projects" && !filterText) {
            process.exit(0);
        }

        if (key.upArrow) {
            handleNavigation("up");
            return;
        }

        if (key.downArrow) {
            handleNavigation("down");
            return;
        }

        if (key.return) {
            if (viewState.viewMode === "projects" && filteredProjects.length > 0) {
                const project = filteredProjects[viewState.selectedIndex];
                if (project) {
                    setFilterText(""); // Clear filter when selecting
                    if (project.isRunning) {
                        // Running project - expand to show agents
                        loadAgents(project.projectId);
                    } else {
                        // Offline project - start it
                        performStart(project.projectId, project.title);
                    }
                }
            } else if (viewState.viewMode === "agents" && viewState.agents.length > 0) {
                const agent = viewState.agents[viewState.selectedIndex];
                if (agent) {
                    loadAgentDetails(agent.pubkey);
                }
            } else if (viewState.viewMode === "agent-detail") {
                if (viewState.selectedIndex === 0) {
                    // View system prompt
                    dispatch({ type: "VIEW_SYSTEM_PROMPT" });
                } else if (viewState.agentLessons.length > 0) {
                    // View lesson (selectedIndex - 1 because index 0 is system prompt)
                    const lessonIndex = viewState.selectedIndex - 1;
                    const lesson = viewState.agentLessons[lessonIndex];
                    if (lesson) {
                        dispatch({ type: "VIEW_LESSON_DETAIL", lesson });
                    }
                }
            }
            return;
        }

        // Handle typing for filter in projects view
        if (viewState.viewMode === "projects" && input && !key.ctrl && !key.meta) {
            // Skip special single-key shortcuts when filtering
            if (!filterText && (input === "c" || input === "k" || input === "r")) {
                if (input === "c") {
                    dispatch({ type: "VIEW_CONVERSATIONS" });
                } else if (input === "k") {
                    performAction("kill");
                } else if (input === "r") {
                    performAction("restart");
                }
                return;
            }
            // Add character to filter
            setFilterText((prev) => prev + input);
            // Reset selection to first item when filtering
            dispatch({ type: "NAVIGATE", direction: "up", maxIndex: 0 });
        }
    });

    const projectTitle = projects.find((p) => p.projectId === viewState.selectedProjectId)?.title;
    const viewTitle = getViewTitle(viewState.viewMode, {
        projectTitle,
        agentName: viewState.selectedAgent?.name,
        lessonTitle: viewState.selectedLesson?.title,
    });

    return (
        <Box flexDirection="column" padding={1}>
            <Box marginBottom={1}>
                <Text bold color="cyan">
                    🚀 TENEX Process Manager
                </Text>
            </Box>

            <Box marginBottom={1}>
                <Text dimColor>{VIEW_INSTRUCTIONS[viewState.viewMode]}</Text>
            </Box>

            <Box marginBottom={1}>
                <Text bold color="green">
                    {viewTitle}
                </Text>
            </Box>

            {viewState.viewMode === "projects" && (
                <>
                    {filterText && (
                        <Box marginBottom={1}>
                            <Text>Filter: </Text>
                            <Text color="yellow">{filterText}</Text>
                            <Text dimColor> ({filteredProjects.length} matches)</Text>
                        </Box>
                    )}
                    <ProjectsView
                        projects={filteredProjects}
                        selectedIndex={viewState.selectedIndex}
                    />
                </>
            )}
            {viewState.viewMode === "conversations" && (
                <ConversationsView
                    conversations={conversations}
                    selectedIndex={viewState.selectedIndex}
                />
            )}
            {viewState.viewMode === "agents" && (
                <AgentsView agents={viewState.agents} selectedIndex={viewState.selectedIndex} />
            )}
            {viewState.viewMode === "agent-detail" && viewState.selectedAgent && (
                <AgentDetailView
                    agent={viewState.selectedAgent}
                    lessons={viewState.agentLessons}
                    selectedIndex={viewState.selectedIndex}
                />
            )}
            {viewState.viewMode === "lesson-detail" && viewState.selectedLesson && (
                <LessonDetailView lesson={viewState.selectedLesson} />
            )}
            {viewState.viewMode === "system-prompt" && viewState.selectedAgent && (
                <SystemPromptView agent={viewState.selectedAgent} />
            )}

            {viewState.statusMessage && (
                <Box marginTop={1}>
                    <Text color="yellow">{viewState.statusMessage}</Text>
                </Box>
            )}
        </Box>
    );
}
