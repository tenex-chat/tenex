import { createSystemReminderContext } from "ai-sdk-system-reminders";
import { trace } from "@opentelemetry/api";
import type { TenexReminderData } from "@/agents/execution/system-reminders";

const ctx = createSystemReminderContext<TenexReminderData>({
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

export function getSystemReminderContext() {
    return ctx;
}
