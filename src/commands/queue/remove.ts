import { getProjectContext } from '@/services';
import { ensureProjectInitialized } from '@/utils/projectInitialization';
import { logger } from '@/utils/logger';
import chalk from 'chalk';
import inquirer from 'inquirer';

interface RemoveOptions {
  conversation?: string;
  confirm?: boolean;
}

export async function removeFromQueue(options: RemoveOptions = {}): Promise<void> {
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

    // Get queue status to show available conversations
    const status = await queueManager.getQueueStatus();
    
    if (status.totalWaiting === 0) {
      console.log(chalk.yellow('Queue is empty - no conversations to remove'));
      return;
    }

    let conversationId = options.conversation;

    // If no conversation specified, prompt to select from queue
    if (!conversationId) {
      const choices = status.queue.map((entry, index) => ({
        name: `${index + 1}. ${entry.conversationId} (queued ${new Date(entry.timestamp).toLocaleTimeString()})`,
        value: entry.conversationId
      }));

      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'conversation',
          message: 'Select conversation to remove from queue:',
          choices
        }
      ]);
      conversationId = answers.conversation;
    }

    // Verify the conversation is actually in the queue
    const position = await queueManager.getQueuePosition(conversationId!);
    if (position === 0) {
      console.error(chalk.red(`Error: Conversation ${conversationId} is not in the queue`));
      process.exit(1);
    }

    // Confirm the removal unless --confirm flag is provided
    if (!options.confirm) {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Remove conversation ${conversationId} from queue (position ${position})?`,
          default: false
        }
      ]);

      if (!answers.confirm) {
        console.log(chalk.yellow('Operation cancelled'));
        return;
      }
    }

    // Remove from queue
    const removed = await queueManager.removeFromQueue(conversationId!);
    
    if (removed) {
      console.log(chalk.green(`✅ Successfully removed ${conversationId} from queue`));
      
      // Show updated queue status
      const newStatus = await queueManager.getQueueStatus();
      if (newStatus.totalWaiting > 0) {
        console.log(chalk.cyan(`\nRemaining in queue: ${newStatus.totalWaiting} conversation(s)`));
      } else {
        console.log(chalk.green('\nQueue is now empty'));
      }
    } else {
      console.log(chalk.yellow(`Conversation ${conversationId} was not in the queue`));
    }

  } catch (error) {
    logger.error('Failed to remove from queue', error);
    console.error(chalk.red('Failed to remove from queue'));
    process.exit(1);
  }
}