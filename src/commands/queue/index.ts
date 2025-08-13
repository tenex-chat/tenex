import { Command } from 'commander';
import { showQueueStatus } from './status';
import { releaseExecutionLock } from './release';
import { removeFromQueue } from './remove';
import { showExecutionHistory } from './history';

export const queueCommand = new Command('queue')
  .description('Manage execution queue for conversations');

// Queue status command
queueCommand
  .command('status')
  .description('View current execution queue status')
  .option('-d, --detailed', 'Show detailed queue information')
  .option('-w, --watch', 'Watch for real-time updates')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    await showQueueStatus(options);
  });

// Force release command
queueCommand
  .command('release')
  .description('Force release the execution lock')
  .option('-c, --conversation <id>', 'Conversation ID to release')
  .option('-r, --reason <reason>', 'Reason for force release')
  .option('-y, --confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    await releaseExecutionLock(options);
  });

// Remove from queue command
queueCommand
  .command('remove')
  .description('Remove a conversation from the execution queue')
  .option('-c, --conversation <id>', 'Conversation ID to remove')
  .option('-y, --confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    await removeFromQueue(options);
  });

// Execution history command
queueCommand
  .command('history')
  .description('View execution history')
  .option('-l, --limit <n>', 'Number of entries to show', '10')
  .option('-f, --format <format>', 'Output format: table|json|csv', 'table')
  .action(async (options) => {
    await showExecutionHistory({
      limit: parseInt(options.limit),
      format: options.format
    });
  });

// Clear all command (admin only)
queueCommand
  .command('clear')
  .description('Clear all queue state (use with caution)')
  .option('-y, --confirm', 'Skip confirmation prompt')
  .action(async (options) => {
    const { clearQueueState } = await import('./clear');
    await clearQueueState(options);
  });