import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContextManager } from "./ProjectContextManager";
import { logger } from "@/utils/logger";
import type { ProjectContext } from "@/services/ProjectContext";

/**
 * Publishes status events for all active projects in the daemon.
 */
export class DaemonStatusPublisher {
  private intervalId: NodeJS.Timeout | null = null;
  private publishIntervalMs: number = 30000; // 30 seconds

  /**
   * Start publishing status events periodically
   */
  start(): void {
    if (this.intervalId) {
      logger.warn("Status publisher already running");
      return;
    }

    logger.info("Starting daemon status publisher", {
      intervalMs: this.publishIntervalMs,
    });

    // Publish immediately on start
    this.publishStatus().catch(error => {
      logger.error("Failed to publish initial status", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Then publish periodically
    this.intervalId = setInterval(() => {
      this.publishStatus().catch(error => {
        logger.error("Failed to publish status", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.publishIntervalMs);
  }

  /**
   * Stop publishing status events
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Daemon status publisher stopped");
    }
  }

  /**
   * Publish status for all loaded projects
   */
  private async publishStatus(): Promise<void> {
    const manager = getProjectContextManager();
    const contexts = manager.getAllContexts();

    if (contexts.size === 0) {
      logger.debug("No projects loaded, skipping status publish");
      return;
    }

    logger.debug("Publishing status for projects", {
      projectCount: contexts.size,
    });

    // Publish individual status for each project.
    // Maintains compatibility with existing clients expecting individual project status events.
    for (const [projectId, context] of contexts) {
      try {
        await this.publishProjectStatus(projectId, context);
      } catch (error) {
        logger.error("Failed to publish status for project", {
          projectId: projectId.slice(0, 20),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Also publish a consolidated daemon status
    await this.publishDaemonStatus(contexts);
  }

  /**
   * Publish status for a single project (backward compatible)
   */
  private async publishProjectStatus(
    projectId: string,
    context: ProjectContext
  ): Promise<void> {
    const ndk = getNDK();

    // Build agent status data
    const agents = Array.from(context.agents.values());
    const agentStatus = agents.map((agent: any) => {
      const agentData: any = {
        pubkey: agent.pubkey,
        slug: agent.slug,
        model: agent.model,
      };

      // Mark the PM agent
      if (agent.pubkey === context.projectManager?.pubkey) {
        agentData.pm = true;
      }

      // Include tools if present (excluding core and delegate tools)
      if (agent.tools && agent.tools.length > 0) {
        const nonCoreTools = agent.tools.filter(
          (tool: string) => !["core-tools", "delegate-tools"].includes(tool)
        );
        if (nonCoreTools.length > 0) {
          agentData.tools = nonCoreTools;
        }
      }

      return agentData;
    });

    // Create status event
    const event = new NDKEvent(ndk);
    event.kind = 24010; // Ephemeral status event
    event.content = JSON.stringify({
      project: {
        id: projectId,
        title: context.project.tagValue("title") || "Untitled",
      },
      agents: agentStatus,
      timestamp: Date.now(),
      version: "1.0.0", // You might want to import this from package.json
    });

    // Add project A-tag for routing
    event.tags.push(["A", projectId]);

    // Sign with project manager's signer
    if (context.signer) {
      event.ndk = ndk;
      await event.sign(context.signer);
      await event.publish();

      logger.debug("Published project status", {
        projectId: projectId.slice(0, 20),
        agentCount: agents.length,
      });
    } else {
      logger.warn("Cannot publish status - no signer available", {
        projectId: projectId.slice(0, 20),
      });
    }
  }

  /**
   * Publish consolidated daemon status
   */
  private async publishDaemonStatus(
    contexts: Map<string, ProjectContext>
  ): Promise<void> {
    const ndk = getNDK();

    // Collect all projects and their agents
    const projects = Array.from(contexts.entries()).map(([projectId, context]) => {
      const agents = Array.from(context.agents.values());
      return {
        id: projectId,
        title: context.project.tagValue("title") || "Untitled",
        agentCount: agents.length,
        agents: agents.map((a: any) => ({
          pubkey: a.pubkey,
          slug: a.slug,
          model: a.model,
          isPM: a.pubkey === context.projectManager?.pubkey,
        })),
      };
    });

    // Create daemon status event
    const event = new NDKEvent(ndk);
    event.kind = 24010; // Ephemeral status event
    event.content = JSON.stringify({
      daemon: {
        version: "2.0.0",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
      projects,
      stats: {
        totalProjects: contexts.size,
        totalAgents: projects.reduce((sum, p) => sum + p.agentCount, 0),
      },
      timestamp: Date.now(),
    });

    // Tag with daemon identifier
    event.tags.push(["d", "tenex-daemon"]);

    // Sign with first available signer
    for (const context of contexts.values()) {
      if (context.signer) {
        event.ndk = ndk;
        await event.sign(context.signer);
        await event.publish();

        logger.debug("Published daemon status", {
          projectCount: contexts.size,
          totalAgents: projects.reduce((sum, p) => sum + p.agentCount, 0),
        });
        break; // Only publish once
      }
    }
  }

  /**
   * Publish a one-time status update
   */
  async publishOnce(): Promise<void> {
    await this.publishStatus();
  }

  /**
   * Update the publish interval
   */
  setInterval(intervalMs: number): void {
    this.publishIntervalMs = intervalMs;

    // Restart if running
    if (this.intervalId) {
      this.stop();
      this.start();
    }
  }

  /**
   * Check if publisher is running
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }
}