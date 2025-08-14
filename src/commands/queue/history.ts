import { getProjectContext } from '@/services';
import { ensureProjectInitialized } from '@/utils/projectInitialization';
import { logger } from '@/utils/logger';
import chalk from 'chalk';
import { format } from 'date-fns';
import Table from 'cli-table3';

interface HistoryOptions {
  limit?: number;
  format?: 'table' | 'json' | 'csv';
}

export async function showExecutionHistory(_options: HistoryOptions = {}): Promise<void> {
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

    // Access the queue manager's internal state for history
    // Note: This requires adding a getExecutionHistory method to ExecutionQueueManager
    const fullStatus = await queueManager.getFullStatus();
    
    // For now, we'll show a message that history is not yet available
    // This would need to be implemented in the ExecutionQueueManager
    console.log(chalk.yellow('Execution history feature is not yet fully implemented'));
    console.log(chalk.gray('This will show past execution records including:'));
    console.log(chalk.gray('  - Conversation ID'));
    console.log(chalk.gray('  - Start and end times'));
    console.log(chalk.gray('  - Duration'));
    console.log(chalk.gray('  - Completion reason (completed/timeout/forced/error)'));
    console.log(chalk.gray('  - Agent public key'));

    // Show current status as a placeholder
    console.log(chalk.bold('\n📊 Current Status:\n'));
    
    if (fullStatus.lock) {
      console.log(chalk.green('Active Execution:'));
      const startTime = new Date(fullStatus.lock.timestamp);
      const duration = Date.now() - fullStatus.lock.timestamp;
      const durationMinutes = Math.floor(duration / 60000);
      
      console.log(`  Conversation: ${fullStatus.lock.conversationId}`);
      console.log(`  Started: ${format(startTime, 'yyyy-MM-dd HH:mm:ss')}`);
      console.log(`  Duration: ${durationMinutes} minutes`);
      console.log(`  Agent: ${fullStatus.lock.agentPubkey}`);
    } else {
      console.log(chalk.gray('No active execution'));
    }

    if (fullStatus.queue.totalWaiting > 0) {
      console.log(chalk.cyan(`\nQueued: ${fullStatus.queue.totalWaiting} conversation(s)`));
    }

  } catch (error) {
    logger.error('Failed to get execution history', error);
    console.error(chalk.red('Failed to get execution history'));
    process.exit(1);
  }
}

function _formatHistory(history: any[], outputFormat: string): void {
  switch (outputFormat) {
    case 'json':
      console.log(JSON.stringify(history, null, 2));
      break;
      
    case 'csv':
      console.log('ConversationID,StartTime,EndTime,Duration(s),Reason,Agent');
      for (const entry of history) {
        const duration = (entry.endTime - entry.startTime) / 1000;
        console.log(`${entry.conversationId},${entry.startTime},${entry.endTime},${duration},${entry.reason},${entry.agentPubkey}`);
      }
      break;
      
    case 'table':
    default:
      const table = new Table({
        head: ['Conversation', 'Start Time', 'Duration', 'Status', 'Agent'],
        colWidths: [20, 20, 15, 15, 20]
      });

      for (const entry of history) {
        const startTime = format(new Date(entry.startTime), 'MM/dd HH:mm');
        const duration = Math.floor((entry.endTime - entry.startTime) / 1000);
        const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
        const status = getStatusColor(entry.reason);
        
        table.push([
          entry.conversationId.substring(0, 18),
          startTime,
          durationStr,
          status,
          entry.agentPubkey.substring(0, 18)
        ]);
      }

      console.log(table.toString());
      break;
  }
}

function getStatusColor(reason: string): string {
  switch (reason) {
    case 'completed':
      return chalk.green('✓ Completed');
    case 'timeout':
      return chalk.yellow('⏱ Timeout');
    case 'forced':
      return chalk.red('✖ Forced');
    case 'error':
      return chalk.red('⚠ Error');
    default:
      return chalk.gray(reason);
  }
}