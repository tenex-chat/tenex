import { describe, expect, it, mock } from "bun:test";
import { TelegramBindingPersistenceService } from "@/services/telegram/TelegramBindingPersistenceService";
import type { TelegramGatewayBinding } from "@/services/telegram/types";

function createBinding(): TelegramGatewayBinding {
    return {
        agent: {
            name: "Telegram Agent",
            slug: "telegram-agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        },
        config: {
            botToken: "token",
            allowDMs: true,
        },
    };
}

describe("TelegramBindingPersistenceService", () => {
    it("remembers Telegram transport bindings for proactive routing", async () => {
        const rememberBinding = mock(() => undefined);
        const service = new TelegramBindingPersistenceService({
            channelBindingStore: {
                rememberBinding,
            } as any,
        });

        const binding = createBinding();
        const result = await service.rememberProjectBinding({
            projectId: "project-alpha",
            binding,
            channelId: "telegram:group:-2001:topic:55",
        });

        expect(rememberBinding).toHaveBeenCalledWith({
            transport: "telegram",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:group:-2001:topic:55",
            projectId: "project-alpha",
        });
        expect(result).toBe(binding);
        expect(binding.config).toEqual({
            botToken: "token",
            allowDMs: true,
        });
    });

    it("remembers Telegram DM bindings as transport bindings too", async () => {
        const rememberBinding = mock(() => undefined);
        const service = new TelegramBindingPersistenceService({
            channelBindingStore: {
                rememberBinding,
            } as any,
        });

        await service.rememberProjectBinding({
            projectId: "project-alpha",
            binding: createBinding(),
            channelId: "telegram:chat:599309204",
        });

        expect(rememberBinding).toHaveBeenCalledWith({
            transport: "telegram",
            agentPubkey: "a".repeat(64),
            channelId: "telegram:chat:599309204",
            projectId: "project-alpha",
        });
    });
});
