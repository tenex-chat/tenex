import * as path from "node:path";
import { TENEX_DIR, CONVERSATIONS_DIR } from "@/constants";
import { FileSystemAdapter } from "./persistence";
import type { ConversationPersistenceAdapter } from "./persistence/types";
import { ExecutionQueueManager } from "./executionQueue";
import {
    ConversationStore,
    ConversationPersistenceService,
    PhaseManager,
    ConversationEventProcessor,
    ProjectAgentResolver,
    ConversationCoordinator as BaseConversationCoordinator,
} from "./services";

/**
 * Main ConversationCoordinator that initializes all services
 */
export class ConversationCoordinator extends BaseConversationCoordinator {
    private projectPath: string;
    private conversationsDir: string;

    constructor(
        projectPath: string, 
        persistence?: ConversationPersistenceAdapter,
        executionQueueManager?: ExecutionQueueManager
    ) {
        const conversationsDir = path.join(projectPath, TENEX_DIR, CONVERSATIONS_DIR);
        
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
        
        this.projectPath = projectPath;
        this.conversationsDir = conversationsDir;
    }

    setExecutionQueueManager(manager: ExecutionQueueManager): void {
        // Call the parent's setExecutionQueueManager method
        super.setExecutionQueueManager(manager);
    }
}