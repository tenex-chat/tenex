/**
 * Conversation Presenters - Presentation layer for conversation data
 *
 * This module provides formatters that sit between the data layer (ConversationCatalogService)
 * and the tool/UI layer, handling display-specific transformations like ID shortening.
 */

export { ConversationPresenter } from "./ConversationPresenter";
export type {
    ConversationDisplayPreview,
    ConversationDisplayEntry,
} from "./ConversationPresenter";
