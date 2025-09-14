import * as cron from 'node-cron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ConfigService } from './ConfigService';
import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';
import { spawn } from 'node:child_process';

interface ScheduledTask {
  id: string;
  schedule: string;
  prompt: string;
  createdAt: string;
  lastRun?: string;
  nextRun?: string;
}

export class SchedulerService {
  private static instance: SchedulerService;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private taskMetadata: Map<string, ScheduledTask> = new Map();
  private taskFilePath: string;
  private ndk: NDK | null = null;
  private projectPath: string | null = null;

  private constructor() {
    const tenexDir = path.join(process.cwd(), '.tenex');
    this.taskFilePath = path.join(tenexDir, 'scheduled_tasks.json');
  }

  public static getInstance(): SchedulerService {
    if (!SchedulerService.instance) {
      SchedulerService.instance = new SchedulerService();
    }
    return SchedulerService.instance;
  }

  public async initialize(
    ndk: NDK,
    projectPath?: string
  ): Promise<void> {
    this.ndk = ndk;
    this.projectPath = projectPath || process.cwd();

    logger.info('Initializing SchedulerService');
    
    // Ensure .tenex directory exists
    const tenexDir = path.dirname(this.taskFilePath);
    await fs.mkdir(tenexDir, { recursive: true });

    // Load existing tasks
    await this.loadTasks();
    
    // Start all loaded tasks
    for (const task of this.taskMetadata.values()) {
      this.startTask(task);
    }
    
    logger.info(`SchedulerService initialized with ${this.taskMetadata.size} tasks`);
  }

  public async addTask(schedule: string, prompt: string): Promise<string> {
    // Validate cron expression
    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron expression: ${schedule}`);
    }

    const taskId = this.generateTaskId();
    const task: ScheduledTask = {
      id: taskId,
      schedule,
      prompt,
      createdAt: new Date().toISOString(),
    };

    this.taskMetadata.set(taskId, task);
    this.startTask(task);
    
    await this.saveTasks();
    
    logger.info(`Scheduled task ${taskId} with schedule: ${schedule}`);
    return taskId;
  }

  public async removeTask(taskId: string): Promise<boolean> {
    const cronTask = this.tasks.get(taskId);
    if (cronTask) {
      cronTask.stop();
      this.tasks.delete(taskId);
      this.taskMetadata.delete(taskId);
      await this.saveTasks();
      logger.info(`Removed scheduled task ${taskId}`);
      return true;
    }
    return false;
  }

  public getTasks(): ScheduledTask[] {
    return Array.from(this.taskMetadata.values());
  }

  private startTask(task: ScheduledTask): void {
    const cronTask = cron.schedule(task.schedule, async () => {
      await this.executeTask(task);
    }, {
      scheduled: true,
      timezone: "UTC"
    });

    this.tasks.set(task.id, cronTask);
  }

  private async executeTask(task: ScheduledTask): Promise<void> {
    logger.info(`Executing scheduled task ${task.id}: ${task.prompt}`);
    
    try {
      if (!this.ndk) {
        throw new Error('SchedulerService not properly initialized');
      }

      // Update last run time
      task.lastRun = new Date().toISOString();
      await this.saveTasks();

      // Get the user's pubkey from config
      const config = ConfigService.getInstance();
      const userPubkey = config.getConfig().userPubkey;

      if (!userPubkey) {
        throw new Error('User pubkey not configured');
      }

      // Create a Nostr event for the scheduled task
      const event = new NDKEvent(this.ndk);
      event.kind = 1; // Text note
      event.content = task.prompt;
      event.tags = [
        ['schedule-task', task.id],
        ['scheduled-at', new Date().toISOString()]
      ];
      
      // Publish the event to trigger normal processing
      await event.publish();

      // Optionally spawn a process to handle the task directly
      if (this.projectPath) {
        const cliBinPath = path.join(__dirname, '..', '..', 'tenex.ts');
        const child = spawn('bun', ['run', cliBinPath, 'project', 'run', '--prompt', task.prompt], {
          cwd: this.projectPath,
          stdio: 'inherit',
          detached: false,
        });

        child.on('exit', (code) => {
          logger.info(`Scheduled task ${task.id} process exited with code ${code}`);
        });

        child.on('error', (error) => {
          logger.error(`Scheduled task ${task.id} process error:`, error);
        });
      }

      logger.info(`Successfully executed scheduled task ${task.id}`);
    } catch (error) {
      logger.error(`Failed to execute scheduled task ${task.id}:`, error);
    }
  }

  private async loadTasks(): Promise<void> {
    try {
      const data = await fs.readFile(this.taskFilePath, 'utf-8');
      const tasks = JSON.parse(data) as ScheduledTask[];
      
      for (const task of tasks) {
        this.taskMetadata.set(task.id, task);
      }
      
      logger.info(`Loaded ${tasks.length} scheduled tasks from disk`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        logger.info('No existing scheduled tasks file found, starting fresh');
      } else {
        logger.error('Failed to load scheduled tasks:', error);
      }
    }
  }

  private async saveTasks(): Promise<void> {
    try {
      const tasks = Array.from(this.taskMetadata.values());
      await fs.writeFile(this.taskFilePath, JSON.stringify(tasks, null, 2));
      logger.debug(`Saved ${tasks.length} scheduled tasks to disk`);
    } catch (error) {
      logger.error('Failed to save scheduled tasks:', error);
    }
  }

  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public shutdown(): void {
    logger.info('Shutting down SchedulerService');
    
    // Stop all cron tasks
    for (const [taskId, cronTask] of this.tasks.entries()) {
      cronTask.stop();
      logger.debug(`Stopped cron task ${taskId}`);
    }
    
    this.tasks.clear();
    logger.info('SchedulerService shutdown complete');
  }
}