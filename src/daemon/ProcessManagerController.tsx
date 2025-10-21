import React from "react";
import { render } from "ink";
import type { Daemon } from "./Daemon";
import { ProcessManagerUI } from "./ProcessManagerUI";
import { logger } from "@/utils/logger";

/**
 * Controller for the Process Manager UI.
 * Handles showing/hiding the UI and managing process operations.
 */
export class ProcessManagerController {
  private daemon: Daemon;
  private renderInstance: any = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(daemon: Daemon, onCloseCallback?: () => void) {
    this.daemon = daemon;
    this.onCloseCallback = onCloseCallback || null;
  }

  /**
   * Show the process manager UI
   */
  show(): void {
    if (this.renderInstance) {
      logger.warn("Process manager already showing");
      return;
    }

    const runtimes = this.daemon.getActiveRuntimes();

    this.renderInstance = render(
      <ProcessManagerUI
        runtimes={runtimes}
        onKill={this.killRuntime.bind(this)}
        onRestart={this.restartRuntime.bind(this)}
        onClose={this.hide.bind(this)}
      />
    );

    logger.debug("Process manager UI shown");
  }

  /**
   * Hide the process manager UI
   */
  hide(): void {
    if (this.renderInstance) {
      this.renderInstance.unmount();
      this.renderInstance = null;
      logger.debug("Process manager UI hidden");

      // Notify parent that UI was closed
      if (this.onCloseCallback) {
        this.onCloseCallback();
      }
    }
  }

  /**
   * Kill a project runtime using the Daemon's public API
   */
  private async killRuntime(projectId: string): Promise<void> {
    logger.info(`Requesting kill for project runtime: ${projectId}`);
    await this.daemon.killRuntime(projectId);
  }

  /**
   * Restart a project runtime using the Daemon's public API
   */
  private async restartRuntime(projectId: string): Promise<void> {
    logger.info(`Requesting restart for project runtime: ${projectId}`);
    await this.daemon.restartRuntime(projectId);
  }
}
