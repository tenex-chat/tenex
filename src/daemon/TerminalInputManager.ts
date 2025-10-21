import { logger } from "@/utils/logger";
import type { Daemon } from "./Daemon";
import type { ProcessManagerController } from "./ProcessManagerController";

/**
 * Manages terminal input for the daemon.
 * Listens for keypresses and triggers actions.
 */
export class TerminalInputManager {
  private daemon: Daemon;
  private isActive = false;
  private originalRawMode: boolean | undefined;
  private keyPressHandler: ((key: string) => void) | null = null;
  private controller: ProcessManagerController | null = null;
  private controllerModulePromise: Promise<typeof import("./ProcessManagerController")> | null = null;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  /**
   * Start listening for terminal input
   */
  start(): void {
    if (this.isActive) {
      logger.warn("TerminalInputManager already active");
      return;
    }

    // Enable raw mode to capture individual keypresses
    if (process.stdin.isTTY) {
      this.originalRawMode = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      // Create bound handler to ensure we can remove it later
      this.keyPressHandler = this.handleKeypress.bind(this);
      process.stdin.on("data", this.keyPressHandler);

      this.isActive = true;
      logger.debug("TerminalInputManager started");
    } else {
      logger.warn("Terminal is not a TTY, cannot enable raw mode for keypress handling");
    }
  }

  /**
   * Stop listening for terminal input
   */
  stop(): void {
    if (!this.isActive) {
      return;
    }

    // Clean up controller if it exists
    if (this.controller) {
      this.controller.hide();
      this.controller = null;
    }

    // Remove the specific handler we added
    if (this.keyPressHandler) {
      process.stdin.removeListener("data", this.keyPressHandler);
      this.keyPressHandler = null;
    }

    // Restore terminal state
    if (process.stdin.isTTY && this.originalRawMode !== undefined) {
      try {
        process.stdin.setRawMode(this.originalRawMode);
        if (!this.originalRawMode) {
          process.stdin.pause();
        }
      } catch (error) {
        logger.warn("Failed to restore terminal raw mode", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.isActive = false;
    logger.debug("TerminalInputManager stopped");
  }

  /**
   * Handle keypress events
   */
  private handleKeypress(key: string): void {
    // Handle Ctrl+C (exit)
    if (key === "\u0003") {
      logger.info("Received Ctrl+C");
      process.emit("SIGINT" as any);
      return;
    }

    // Handle 'p' key - toggle process manager
    if (key === "p" || key === "P") {
      logger.debug("Process manager key pressed");
      this.toggleProcessManager();
    }
  }

  /**
   * Toggle the process manager UI (show if hidden, hide if shown)
   */
  private toggleProcessManager(): void {
    if (this.controller) {
      // UI is already shown, close it
      logger.debug("Closing process manager");
      this.controller.hide();
      this.controller = null;
    } else {
      // UI is not shown, open it
      this.showProcessManager();
    }
  }

  /**
   * Show the process manager UI
   */
  private showProcessManager(): void {
    // If we're already loading the controller, don't start another load
    if (this.controllerModulePromise) {
      logger.debug("Controller module already loading, ignoring duplicate request");
      return;
    }

    // Import dynamically to avoid circular dependencies
    this.controllerModulePromise = import("./ProcessManagerController");

    this.controllerModulePromise
      .then(({ ProcessManagerController }) => {
        this.controller = new ProcessManagerController(this.daemon, () => {
          // Callback when UI is closed
          this.controller = null;
        });
        this.controller.show();
        this.controllerModulePromise = null;
      })
      .catch((error) => {
        logger.error("Failed to show process manager", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.controllerModulePromise = null;
      });
  }
}
