import { getProjectContext } from '@/services';
import { ensureProjectInitialized } from '@/utils/projectInitialization';
import { logger } from '@/utils/logger';
import chalk from 'chalk';
import inquirer from 'inquirer';

interface ReleaseOptions {
  conversation?: string;
  reason?: string;
  confirm?: boolean;
}

export async function releaseExecutionLock(options: ReleaseOptions = {}): Promise<void> {
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

    // Get current lock to determine which conversation to release
    const currentLock = await queueManager.getCurrentLock();
    
    if (!currentLock) {
      console.log(chalk.yellow('No execution lock currently held'));
      return;
    }

    const conversationId = options.conversation || currentLock.conversationId;
    let reason = options.reason;

    // If no conversation specified, use the current lock
    if (!options.conversation) {
      console.log(chalk.cyan(`Current execution: ${currentLock.conversationId}`));
    }

    // Verify the conversation matches the current lock
    if (conversationId !== currentLock.conversationId) {
      console.error(chalk.red(`Error: Conversation ${conversationId} does not hold the execution lock`));
      console.log(chalk.yellow(`Current lock holder: ${currentLock.conversationId}`));
      process.exit(1);
    }

    // Prompt for reason if not provided
    if (!reason) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'reason',
          message: 'Reason for force release:',
          default: 'manual_override',
          validate: (input) => input.length > 0 || 'Reason is required'
        }
      ]);
      reason = answers.reason;
    }

    // Confirm the release unless --confirm flag is provided
    if (!options.confirm) {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Force release execution lock for conversation ${conversationId}?`,
          default: false
        }
      ]);

      if (!answers.confirm) {
        console.log(chalk.yellow('Operation cancelled'));
        return;
      }
    }

    // Perform the force release
    if (!reason) {
      throw new Error('Reason is required for force release');
    }
    await queueManager.forceRelease(conversationId, reason);
    
    console.log(chalk.green(`✅ Successfully released lock for conversation ${conversationId}`));
    console.log(chalk.gray(`Reason: ${reason}`));

    // Check if there's a next conversation in queue
    const status = await queueManager.getFullStatus();
    if (status.queue.totalWaiting > 0) {
      console.log(chalk.cyan(`\nNext in queue will automatically acquire the lock`));
    }

    // Exit cleanly
    process.exit(0);
  } catch (error) {
    logger.error('Failed to release execution lock', error);
    console.error(chalk.red('Failed to release execution lock'));
    process.exit(1);
  }
}