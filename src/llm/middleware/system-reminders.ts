import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import {
    createSystemReminderRegistry,
    createSystemRemindersMiddleware,
    createSystemRemindersProviderOptions,
    type SystemRemindersMiddleware,
} from "ai-sdk-system-reminders";

export const TENEX_SYSTEM_REMINDER_TAGS = {
    dynamicContext: "dynamic-context",
    ephemeral: "ephemeral",
} as const;

interface TenexSystemReminderMetadata {
    dynamicContext?: string;
    ephemeralContents?: string[];
}

function getString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const strings = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return strings.length > 0 ? strings : undefined;
}

const tenexSystemReminderRegistry = createSystemReminderRegistry({
    [TENEX_SYSTEM_REMINDER_TAGS.dynamicContext]: ({ metadata }) =>
        getString((metadata as TenexSystemReminderMetadata | undefined)?.dynamicContext),
    [TENEX_SYSTEM_REMINDER_TAGS.ephemeral]: ({ metadata }) =>
        getStringArray((metadata as TenexSystemReminderMetadata | undefined)?.ephemeralContents),
});

export function createTenexSystemRemindersMiddleware(): SystemRemindersMiddleware {
    return createSystemRemindersMiddleware({
        registry: tenexSystemReminderRegistry,
    });
}

export function createTenexSystemReminderProviderOptions(input: {
    dynamicContext?: string;
    ephemeralContents?: string[];
}): ProviderOptions | undefined {
    const dynamicContext = getString(input.dynamicContext);
    const ephemeralContents = getStringArray(input.ephemeralContents);
    const tags: string[] = [];

    if (dynamicContext) {
        tags.push(TENEX_SYSTEM_REMINDER_TAGS.dynamicContext);
    }

    if (ephemeralContents) {
        tags.push(TENEX_SYSTEM_REMINDER_TAGS.ephemeral);
    }

    if (tags.length === 0) {
        return undefined;
    }

    return createSystemRemindersProviderOptions({
        tags,
        metadata: {
            ...(dynamicContext ? { dynamicContext } : {}),
            ...(ephemeralContents ? { ephemeralContents } : {}),
        },
    }) as ProviderOptions;
}
