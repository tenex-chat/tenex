/**
 * Unified Daemon Module
 *
 * This module implements a single-process daemon that manages multiple projects
 * and agents, replacing the previous multi-process architecture.
 */

export { UnifiedDaemon, getUnifiedDaemon, resetUnifiedDaemon } from "./UnifiedDaemon";
export { ProjectContextManager, getProjectContextManager, resetProjectContextManager } from "./ProjectContextManager";
export { UnifiedSubscriptionManager } from "./UnifiedSubscriptionManager";
export { UnifiedEventRouter } from "./UnifiedEventRouter";
export { UnifiedStatusPublisher } from "./UnifiedStatusPublisher";