import { combineSystemReminders } from "ai-sdk-system-reminders";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import { trace } from "@opentelemetry/api";
import { getSystemReminderContext } from "../system-reminder-context";

export function createTenexSystemRemindersMiddleware(): LanguageModelV3Middleware {
    return {
        specificationVersion: "v3" as const,

        async transformParams({ params }) {
            const ctx = getSystemReminderContext();
            const reminders = await ctx.collect();

            if (reminders.length === 0) return params;

            const combinedXml = combineSystemReminders(reminders);
            if (combinedXml === "") return params;

            const span = trace.getActiveSpan();
            if (span) {
                span.addEvent("system-reminders.applied", {
                    "reminders.count": reminders.length,
                    "reminders.types": reminders.map((r) => r.type).join(","),
                    "reminders.content": combinedXml,
                });
            }

            const prompt = [...params.prompt];

            // Find the last system message and append reminders to it
            for (let i = prompt.length - 1; i >= 0; i--) {
                const msg = prompt[i];
                if (msg.role === "system") {
                    prompt[i] = {
                        role: "system" as const,
                        content: `${msg.content}\n\n${combinedXml}`,
                        providerOptions: msg.providerOptions,
                    };
                    return { ...params, prompt };
                }
            }

            // No system message found — prepend one
            prompt.unshift({
                role: "system" as const,
                content: combinedXml,
            });

            return { ...params, prompt };
        },
    };
}
