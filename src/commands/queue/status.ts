import { ExecutionQueueManager } from '@/conversations/executionQueue';
import { getProjectContext } from '@/services';
import { ensureProjectInitialized } from '@/utils/projectInitialization';
import { logger } from '@/utils/logger';
import chalk from 'chalk';
import { formatDistanceToNow } from 'date-fns';

interface StatusOptions {
  detailed?: boolean;
  json?: boolean;
  watch?: boolean;
}

export async function showQueueStatus(options: StatusOptions = {}): Promise<void> {
  try {
    // Initialize project context first
    await ensureProjectInitialized(process.cwd());
    
    const projectContext = getProjectContext();
    const conversationManager = projectContext.conversationManager;
    
    if (!conversationManager) {
      console.error(chalk.red('Error: No conversation manager available'));
      process.exit(1);
    }

    const queueManager = conversationManager.getExecutionQueueManager();
    
    if (!queueManager) {
      console.error(chalk.red('Error: Execution queue management not enabled for this project'));
      process.exit(1);
    }

    const status = await queueManager.getFullStatus();

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    if (options.watch) {
      await watchQueueStatus(queueManager);
      return;
    }

    displayQueueStatus(status, options.detailed);
    
    // Exit cleanly after displaying status
    process.exit(0);
  } catch (error) {
    logger.error('Failed to get queue status', error);
    console.error(chalk.red('Failed to get queue status'));
    process.exit(1);
  }
}

function displayQueueStatus(status: unknown, detailed?: boolean): void {
  console.log(chalk.bold('\n🚦 Execution Queue Status\n'));

  // Display lock status
  if (status.lock) {
    console.log(chalk.green('Lock Status: 🔒 LOCKED'));
    console.log(chalk.white(`Current Execution: ${status.lock.conversationId}`));
    
    if (detailed) {
      console.log(chalk.gray(`  Agent: ${status.lock.agentPubkey}`));
      const startTime = new Date(status.lock.timestamp);
      console.log(chalk.gray(`  Started: ${startTime.toLocaleString()} (${formatDistanceToNow(startTime, { addSuffix: true })})`));
      
      const timeoutTime = new Date(status.lock.timestamp + status.lock.maxDuration);
      console.log(chalk.gray(`  Timeout: ${timeoutTime.toLocaleString()} (${formatDistanceToNow(timeoutTime, { addSuffix: true })})`));
    }
  } else {
    console.log(chalk.yellow('Lock Status: 🔓 UNLOCKED'));
    console.log(chalk.gray('No active execution'));
  }

  console.log();

  // Display queue information
  const queueLength = status.queue.totalWaiting;
  
  if (queueLength > 0) {
    console.log(chalk.cyan(`Queue: ${queueLength} conversation(s) waiting`));
    
    if (status.queue.estimatedWait > 0) {
      const waitMinutes = Math.ceil(status.queue.estimatedWait / 60);
      console.log(chalk.gray(`  Estimated wait for new requests: ~${waitMinutes} minutes`));
    }
    
    if (detailed) {
      console.log();
      console.log(chalk.bold('Queue Order:'));
      
      const maxDisplay = detailed ? 10 : 3;
      const displayCount = Math.min(maxDisplay, status.queue.queue.length);
      
      for (let i = 0; i < displayCount; i++) {
        const entry = status.queue.queue[i];
        const queueTime = new Date(entry.timestamp);
        console.log(chalk.white(`  ${i + 1}. ${entry.conversationId}`));
        console.log(chalk.gray(`     Queued: ${formatDistanceToNow(queueTime, { addSuffix: true })}`));
        
        if (entry.retryCount > 0) {
          console.log(chalk.yellow(`     Retries: ${entry.retryCount}`));
        }
      }
      
      if (status.queue.queue.length > displayCount) {
        console.log(chalk.gray(`  ... and ${status.queue.queue.length - displayCount} more`));
      }
    }
  } else {
    console.log(chalk.green('Queue: Empty'));
    console.log(chalk.gray('No conversations waiting for execution'));
  }

  // Display active timeouts if detailed
  if (detailed && status.activeTimeouts?.length > 0) {
    console.log();
    console.log(chalk.bold('Active Timeouts:'));
    for (const conversationId of status.activeTimeouts) {
      console.log(chalk.yellow(`  - ${conversationId}`));
    }
  }

  console.log();
}

async function watchQueueStatus(queueManager: ExecutionQueueManager): Promise<void> {
  console.log(chalk.cyan('📡 Watching queue status (Press Ctrl+C to exit)...\n'));

  const displayCurrentStatus = async (): Promise<void> => {
    console.clear();
    const status = await queueManager.getFullStatus();
    displayQueueStatus(status, true);
  };

  // Display initial status
  await displayCurrentStatus();

  // Set up event listeners
  queueManager.on('lock-acquired', async () => {
    await displayCurrentStatus();
  });

  queueManager.on('lock-released', async () => {
    await displayCurrentStatus();
  });

  queueManager.on('queue-joined', async () => {
    await displayCurrentStatus();
  });

  queueManager.on('queue-left', async () => {
    await displayCurrentStatus();
  });

  // Also poll periodically as backup
  const interval = setInterval(async () => {
    await displayCurrentStatus();
  }, 30000); // Every 30 seconds

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log(chalk.cyan('\n👋 Stopped watching queue status'));
    process.exit(0);
  });
}