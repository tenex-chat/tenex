import { getProjectContext } from '@/services';
import { ensureProjectInitialized } from '@/utils/projectInitialization';
import { logger } from '@/utils/logger';
import chalk from 'chalk';
import inquirer from 'inquirer';

interface ClearOptions {
  confirm?: boolean;
}

export async function clearQueueState(options: ClearOptions = {}): Promise<void> {
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

    // Get current status to show what will be cleared
    const status = await queueManager.getFullStatus();
    
    console.log(chalk.yellow('⚠️  WARNING: This will clear all queue state'));
    console.log();
    
    if (status.lock) {
      console.log(chalk.red('Active execution will be terminated:'));
      console.log(`  - ${status.lock.conversationId}`);
    }
    
    if (status.queue.totalWaiting > 0) {
      console.log(chalk.red(`${status.queue.totalWaiting} queued conversation(s) will be removed`));
    }
    
    if (status.activeTimeouts?.length > 0) {
      console.log(chalk.red(`${status.activeTimeouts.length} active timeout(s) will be cleared`));
    }
    
    console.log();

    // Confirm the clear operation unless --confirm flag is provided
    if (!options.confirm) {
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: chalk.red('Are you absolutely sure you want to clear all queue state?'),
          default: false
        },
        {
          type: 'input',
          name: 'doubleCheck',
          message: 'Type "CLEAR" to confirm:',
          when: (answers) => answers.confirm,
          validate: (input) => input === 'CLEAR' || 'Please type CLEAR to confirm'
        }
      ]);

      if (!answers.confirm || answers.doubleCheck !== 'CLEAR') {
        console.log(chalk.yellow('Operation cancelled'));
        return;
      }
    }

    // Clear all state
    await queueManager.clearAll();
    
    console.log(chalk.green('✅ Successfully cleared all queue state'));
    console.log(chalk.gray('  - Lock released'));
    console.log(chalk.gray('  - Queue cleared'));
    console.log(chalk.gray('  - Timeouts cancelled'));

  } catch (error) {
    logger.error('Failed to clear queue state', error);
    console.error(chalk.red('Failed to clear queue state'));
    process.exit(1);
  }
}