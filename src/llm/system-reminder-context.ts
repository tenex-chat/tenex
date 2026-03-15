import { AsyncLocalStorage } from "node:async_hooks";
import {
    createSystemReminderContext,
    type SystemReminderContext,
} from "ai-sdk-system-reminders";
import { trace } from "@opentelemetry/api";
import type { TenexReminderData } from "@/agents/execution/system-reminders";

const reminderContextStorage = new AsyncLocalStorage<SystemReminderContext<TenexReminderData>>();

function buildReminderContext(): SystemReminderContext<TenexReminderData> {
    return createSystemReminderContext<TenexReminderData>({
        onCollect(reminders) {
            trace.getActiveSpan()?.addEvent("system_reminders.collected", {
                "reminder.count": reminders.length,
                "reminder.types": reminders.map((r) => r.type).join(","),
            });
        },
        onProviderError(type, error) {
            trace.getActiveSpan()?.addEvent("system_reminders.provider_error", {
                "provider.type": type,
                "error.message": error instanceof Error ? error.message : String(error),
            });
        },
    });
}

const fallbackContext = buildReminderContext();

export function createTenexSystemReminderContext(): SystemReminderContext<TenexReminderData> {
    return buildReminderContext();
}

export function runWithSystemReminderContext<T>(
    callback: () => Promise<T> | T,
    context: SystemReminderContext<TenexReminderData> = createTenexSystemReminderContext()
): Promise<T> | T {
    return reminderContextStorage.run(context, callback);
}

export function getSystemReminderContext(): SystemReminderContext<TenexReminderData> {
    return reminderContextStorage.getStore() ?? fallbackContext;
}
