import {
    type TransportBindingStore,
    getTransportBindingStore,
} from "@/services/ingress/TransportBindingStoreService";
import type { TelegramGatewayBinding } from "@/services/telegram/types";

interface TelegramBindingPersistenceServiceOptions {
    channelBindingStore?: Pick<TransportBindingStore, "rememberBinding">;
}

export class TelegramBindingPersistenceService {
    private readonly channelBindingStore: Pick<TransportBindingStore, "rememberBinding">;

    constructor(options: TelegramBindingPersistenceServiceOptions = {}) {
        this.channelBindingStore = options.channelBindingStore ?? getTransportBindingStore();
    }

    async rememberProjectBinding(params: {
        projectId: string;
        binding: TelegramGatewayBinding;
        channelId: string;
        message?: unknown;
        projectContext?: unknown;
    }): Promise<TelegramGatewayBinding> {
        this.channelBindingStore.rememberBinding({
            transport: "telegram",
            agentPubkey: params.binding.agent.pubkey,
            channelId: params.channelId,
            projectId: params.projectId,
        });

        return params.binding;
    }
}
