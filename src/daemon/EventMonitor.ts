import type { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";
import { getNDK } from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";
import type { IProcessManager } from "./ProcessManager";
import type { IProjectManager } from "./ProjectManager";

export interface IEventMonitor {
  start(whitelistedPubkeys: string[]): Promise<void>;
  stop(): Promise<void>;
}

export class EventMonitor implements IEventMonitor {
  private subscription: NDKSubscription | null = null;

  constructor(
    private projectManager: IProjectManager,
    private processManager: IProcessManager
  ) {}

  async start(whitelistedPubkeys: string[]): Promise<void> {
    const filter: NDKFilter = {
      authors: whitelistedPubkeys,
      limit: 0,
    };

    this.subscription = getNDK().subscribe(filter, {
      closeOnEose: false,
      groupable: false,
    });

    this.subscription.on("event", (event: NDKEvent) => {
      this.handleEvent(event).catch((error) => {
        logger.error("Error handling event", { error, event: event.id });
      });
    });
  }

  async stop(): Promise<void> {
    if (this.subscription) {
      this.subscription.stop();
      this.subscription = null;
    }
  }

  private async handleEvent(event: NDKEvent): Promise<void> {
    // Check if event has project "a" tag
    const projectTag = this.getProjectTag(event);
    if (!projectTag) {
      return;
    }

    const projectIdentifier = this.extractProjectIdentifier(projectTag);
    if (!projectIdentifier) {
      return;
    }

    logger.info(`Received event kind ${event.kind}`);

    // Check if project is already running
    if (await this.processManager.isProjectRunning(projectIdentifier)) {
      return;
    }

    // Ensure project exists and get path
    try {
      const naddr = this.reconstructNaddr(projectTag, event.pubkey);
      const projectPath = await this.projectManager.ensureProjectExists(
        projectIdentifier,
        naddr,
        getNDK()
      );

      // Spawn project run process
      await this.processManager.spawnProjectRun(projectPath, projectIdentifier);

      logger.info("Started project process", {
        projectIdentifier,
        projectPath,
      });
    } catch (error) {
      logger.error("Failed to start project", {
        error,
        projectIdentifier,
      });
    }
  }

  private getProjectTag(event: NDKEvent): string | undefined {
    const aTag = event.tags.find((tag) => tag[0] === "a");
    return aTag ? aTag[1] : undefined;
  }

  private extractProjectIdentifier(aTag: string): string | undefined {
    // Format: kind:pubkey:identifier
    const parts = aTag.split(":");
    if (parts.length >= 3) {
      return parts[2];
    }
    return undefined;
  }

  private reconstructNaddr(aTag: string, eventPubkey: string): string {
    // Parse the a tag to get project details
    const parts = aTag.split(":");
    if (parts.length < 3) {
      throw new Error("Invalid project a tag format");
    }

    const [kind, pubkey, identifier] = parts;

    // Validate that kind is present
    if (!kind) {
      throw new Error("Missing kind in project a tag");
    }

    // Use the pubkey from the a tag if available, otherwise use event pubkey
    const projectPubkey = pubkey || eventPubkey;

    // Encode as naddr
    return nip19.naddrEncode({
      identifier: identifier || "",
      pubkey: projectPubkey,
      kind: Number.parseInt(kind, 10),
    });
  }
}
