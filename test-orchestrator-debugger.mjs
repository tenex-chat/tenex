// Quick test to verify OrchestratorDebugger builds narrative correctly
import { OrchestratorTurnTracker } from './dist/conversations/services/OrchestratorTurnTracker.js';
import { PHASES } from './dist/conversations/phases.js';

const tracker = new OrchestratorTurnTracker();
const conversationId = 'test-conv';

// Start a turn and add completion
tracker.startTurn(conversationId, PHASES.CHAT, ['project-manager'], 'User needs analysis');
tracker.addCompletion(conversationId, 'project-manager', 'The README is outdated and needs updating');

// Build the context
const context = tracker.buildRoutingContext(conversationId, 'Tell me if the README is good');

console.log('=== GENERATED WORKFLOW NARRATIVE ===');
console.log(context.workflow_narrative);
console.log('=====================================');

// Verify it contains expected elements
const hasContext = context.workflow_narrative.includes('ORCHESTRATOR ROUTING CONTEXT');
const hasHistory = context.workflow_narrative.includes('WORKFLOW HISTORY');
const hasCompletion = context.workflow_narrative.includes('The README is outdated');
const hasAnalysisNote = context.workflow_narrative.includes('analysis/review request');

console.log('\nValidation:');
console.log('✓ Has context header:', hasContext);
console.log('✓ Has workflow history:', hasHistory);
console.log('✓ Has completion message:', hasCompletion);
console.log('✓ Has analysis detection:', hasAnalysisNote);

if (hasContext && hasHistory && hasCompletion && hasAnalysisNote) {
    console.log('\n✅ All checks passed!');
} else {
    console.log('\n❌ Some checks failed');
    process.exit(1);
}
