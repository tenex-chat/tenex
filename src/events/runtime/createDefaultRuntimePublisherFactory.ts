import type { AgentRuntimePublisherFactory } from "@/events/runtime/AgentRuntimePublisherFactory";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";
import { TelegramRuntimePublisher } from "@/services/telegram/TelegramRuntimePublisherService";

export function createDefaultRuntimePublisherFactory(
    telegramDeliveryService: TelegramDeliveryService = new TelegramDeliveryService()
): AgentRuntimePublisherFactory {
    return (agent) =>
        agent.telegram?.botToken
            ? new TelegramRuntimePublisher(agent, telegramDeliveryService)
            : new AgentPublisher(agent);
}
