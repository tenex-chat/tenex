import type { AgentRuntimePublisherFactory } from "@/events/runtime/AgentRuntimePublisherFactory";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { TelegramDeliveryService } from "@/services/telegram/TelegramDeliveryService";
import { TelegramRuntimePublisherService } from "@/services/telegram/TelegramRuntimePublisherService";

export function createDefaultRuntimePublisherFactory(
    telegramDeliveryService: TelegramDeliveryService = new TelegramDeliveryService()
): AgentRuntimePublisherFactory {
    return (agent) =>
        agent.telegram?.botToken
            ? new TelegramRuntimePublisherService(agent, telegramDeliveryService)
            : new AgentPublisher(agent);
}
