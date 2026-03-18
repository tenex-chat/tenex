function normalizeNumericSegment(value: string | number): string {
    return String(value).replace(/^-/, "n").replace(/[^a-zA-Z0-9_]/g, "_");
}

function denormalizeNumericSegment(value: string): string {
    return value.startsWith("n") ? `-${value.slice(1)}` : value;
}

export function createTelegramChannelId(
    chatId: string | number,
    messageThreadId?: string | number
): string {
    const normalizedChatId = String(chatId);
    if (messageThreadId !== undefined) {
        return `telegram:group:${normalizedChatId}:topic:${messageThreadId}`;
    }
    return `telegram:chat:${normalizedChatId}`;
}

export function parseTelegramChannelId(channelId: string): {
    chatId: string;
    messageThreadId?: string;
} | undefined {
    if (!channelId.startsWith("telegram:")) {
        return undefined;
    }

    const parts = channelId.split(":");
    if (parts[1] === "chat" && parts[2]) {
        return { chatId: parts[2] };
    }

    if (parts[1] === "group" && parts[2]) {
        return {
            chatId: parts[2],
            messageThreadId: parts[4],
        };
    }

    return undefined;
}

export function createTelegramNativeMessageId(
    chatId: string | number,
    messageId: string | number
): string {
    return `tg_${normalizeNumericSegment(chatId)}_${normalizeNumericSegment(messageId)}`;
}

export function parseTelegramNativeMessageId(nativeMessageId: string): {
    chatId: string;
    messageId: string;
} | undefined {
    if (!nativeMessageId.startsWith("tg_")) {
        return undefined;
    }

    const payload = nativeMessageId.slice(3);
    const separatorIndex = payload.lastIndexOf("_");
    if (separatorIndex === -1) {
        return undefined;
    }

    const chatSegment = payload.slice(0, separatorIndex);
    const messageSegment = payload.slice(separatorIndex + 1);
    if (!chatSegment || !messageSegment) {
        return undefined;
    }

    return {
        chatId: denormalizeNumericSegment(chatSegment),
        messageId: denormalizeNumericSegment(messageSegment),
    };
}
