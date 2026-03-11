import { buildMessagesFromEntries } from "@/conversations/MessageBuilder";

export { buildMessagesFromEntries as buildPromptMessagesFromRecords };

export type {
    AddressableModelMessage as PromptMessage,
    MessageBuilderContext as PromptBuilderContext,
} from "@/conversations/MessageBuilder";
