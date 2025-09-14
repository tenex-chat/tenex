import NDK, { NDKEvent, NDKFilter, NDKSubscription } from '@nostr-dev-kit/ndk';
import { logger } from '../utils/logger';
import { SchedulerService } from '../services/SchedulerService';
import { ConfigService } from '../services/ConfigService';

export class ScheduledTaskHandler {
  private ndk: NDK;
  private schedulerService: SchedulerService;
  private subscription: NDKSubscription | null = null;
  private authorizedPubkeys: Set<string> = new Set();

  constructor(ndk: NDK, schedulerService: SchedulerService) {
    this.ndk = ndk;
    this.schedulerService = schedulerService;
  }

  public async initialize(): Promise<void> {
    logger.info('Initializing ScheduledTaskHandler');
    
    // Load authorized pubkeys
    await this.loadAuthorizedPubkeys();
    
    // Subscribe to kind:4242 events
    this.subscribeToScheduleEvents();
    
    logger.info('ScheduledTaskHandler initialized');
  }

  private async loadAuthorizedPubkeys(): Promise<void> {
    const config = ConfigService.getInstance().getConfig();
    
    // Add user's pubkey
    if (config.userPubkey) {
      this.authorizedPubkeys.add(config.userPubkey);
    }
    
    // Add system agent pubkeys
    if (config.systemAgentPubkeys) {
      for (const pubkey of config.systemAgentPubkeys) {
        this.authorizedPubkeys.add(pubkey);
      }
    }
    
    // Add any additional authorized pubkeys from config
    if (config.authorizedSchedulers) {
      for (const pubkey of config.authorizedSchedulers) {
        this.authorizedPubkeys.add(pubkey);
      }
    }
    
    logger.info(`Loaded ${this.authorizedPubkeys.size} authorized pubkeys for scheduling`);
  }

  private subscribeToScheduleEvents(): void {
    const filter: NDKFilter = {
      kinds: [4242],
      since: Math.floor(Date.now() / 1000) // Only listen for new events
    };

    this.subscription = this.ndk.subscribe(filter, {
      closeOnEose: false
    });

    this.subscription.on('event', async (event: NDKEvent) => {
      await this.handleScheduleEvent(event);
    });

    logger.info('Subscribed to kind:4242 schedule events');
  }

  private async handleScheduleEvent(event: NDKEvent): Promise<void> {
    try {
      logger.info(`Received kind:4242 event from ${event.pubkey}`);
      
      // Validate the sender is authorized
      if (!this.isAuthorized(event.pubkey)) {
        logger.warn(`Unauthorized schedule attempt from pubkey: ${event.pubkey}`);
        return;
      }

      // Extract schedule and prompt from event
      const schedule = this.extractSchedule(event);
      const prompt = event.content;

      if (!schedule) {
        logger.error('Schedule event missing required "schedule" tag');
        return;
      }

      if (!prompt) {
        logger.error('Schedule event missing prompt in content');
        return;
      }

      // Add the task to the scheduler
      const taskId = await this.schedulerService.addTask(schedule, prompt);
      
      logger.info(`Successfully scheduled task ${taskId} from Nostr event`);
      
      // Optionally publish a confirmation event
      await this.publishConfirmation(event, taskId);
      
    } catch (error) {
      logger.error('Failed to handle schedule event:', error);
    }
  }

  private isAuthorized(pubkey: string): boolean {
    return this.authorizedPubkeys.has(pubkey);
  }

  private extractSchedule(event: NDKEvent): string | null {
    const scheduleTags = event.tags.filter(tag => tag[0] === 'schedule');
    
    if (scheduleTags.length > 0 && scheduleTags[0][1]) {
      return scheduleTags[0][1];
    }
    
    return null;
  }

  private async publishConfirmation(originalEvent: NDKEvent, taskId: string): Promise<void> {
    try {
      const confirmationEvent = new NDKEvent(this.ndk);
      confirmationEvent.kind = 4243; // Custom kind for schedule confirmations
      confirmationEvent.content = `Task scheduled successfully with ID: ${taskId}`;
      confirmationEvent.tags = [
        ['e', originalEvent.id],
        ['p', originalEvent.pubkey],
        ['task-id', taskId]
      ];

      await confirmationEvent.publish();
      logger.debug(`Published schedule confirmation for task ${taskId}`);
    } catch (error) {
      logger.error('Failed to publish schedule confirmation:', error);
    }
  }

  public async addScheduleCommand(taskId: string, command: string): Promise<void> {
    try {
      const commandEvent = new NDKEvent(this.ndk);
      commandEvent.kind = 4244; // Custom kind for schedule commands
      commandEvent.content = command;
      commandEvent.tags = [
        ['task-id', taskId],
        ['command', 'cancel' | 'pause' | 'resume']
      ];

      await commandEvent.publish();
      logger.info(`Published schedule command for task ${taskId}: ${command}`);
    } catch (error) {
      logger.error('Failed to publish schedule command:', error);
    }
  }

  public shutdown(): void {
    if (this.subscription) {
      this.subscription.stop();
      logger.info('Stopped listening to schedule events');
    }
  }
}