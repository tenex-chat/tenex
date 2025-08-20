import type { ExecutionQueueManager } from "./executionQueue";
import { FileSystemAdapter } from "./persistence";
import type { ConversationPersistenceAdapter } from "./persistence/types";
import {
  ConversationCoordinator as BaseConversationCoordinator,
  ConversationEventProcessor,
  ConversationPersistenceService,
  ConversationStore,
  PhaseManager,
  ProjectAgentResolver,
} from "./services";

/**
 * Main ConversationCoordinator that initializes all services
 */
export class ConversationCoordinator extends BaseConversationCoordinator {
  constructor(
    projectPath: string,
    persistence?: ConversationPersistenceAdapter,
    executionQueueManager?: ExecutionQueueManager
  ) {
    // Create services
    const store = new ConversationStore();
    const persistenceService = new ConversationPersistenceService(
      persistence || new FileSystemAdapter(projectPath)
    );
    const phaseManager = new PhaseManager(executionQueueManager);
    const eventProcessor = new ConversationEventProcessor();
    const agentResolver = new ProjectAgentResolver();

    // Call parent constructor
    super(
      store,
      persistenceService,
      phaseManager,
      eventProcessor,
      agentResolver,
      executionQueueManager
    );
  }

  setExecutionQueueManager(manager: ExecutionQueueManager): void {
    // Call the parent's setExecutionQueueManager method
    super.setExecutionQueueManager(manager);
  }
}
