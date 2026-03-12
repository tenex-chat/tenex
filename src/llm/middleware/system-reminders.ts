import { applySystemReminders, combineSystemReminders } from "ai-sdk-system-reminders";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import { trace } from "@opentelemetry/api";
import { getSystemReminderContext } from "../system-reminder-context";

export function createTenexSystemRemindersMiddleware(): LanguageModelV3Middleware {
    const ctx = getSystemReminderContext();

    return {
        specificationVersion: "v3" as const,

        async transformParams({ params }) {
            const reminders = await ctx.collect();

            if (reminders.length === 0) return params;

            const combinedXml = combineSystemReminders(reminders);

            const span = trace.getActiveSpan();
            if (span) {
                span.addEvent("system-reminders.applied", {
                    "reminders.count": reminders.length,
                    "reminders.types": reminders.map((r) => r.type).join(","),
                    "reminders.content": combinedXml,
                });
            }

            return {
                ...params,
                prompt: applySystemReminders(params.prompt, reminders),
            };
        },
    };
}
