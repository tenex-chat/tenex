import { logger } from "@/utils/logger";
import { render, type Instance } from "ink";
import React from "react";
import type { Daemon } from "./Daemon";
import { ProcessManagerUI } from "./ProcessManagerUI";

/**
 * Controller for the Process Manager UI.
 * Handles showing/hiding the UI and managing process operations.
 */
export class ProcessManagerController {
    private daemon: Daemon;
    private renderInstance: Instance | null = null;
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

        const knownProjects = this.daemon.getKnownProjects();
        const runtimes = this.daemon.getActiveRuntimes();

        this.renderInstance = render(
            <ProcessManagerUI
                knownProjects={knownProjects}
                runtimes={runtimes}
                onStart={this.startRuntime.bind(this)}
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
     * Start a project runtime using the Daemon's public API
     */
    private async startRuntime(projectId: string): Promise<void> {
        logger.info(`Requesting start for project runtime: ${projectId}`);
        await this.daemon.startRuntime(projectId);
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
