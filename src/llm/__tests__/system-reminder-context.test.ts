import { afterEach, describe, expect, test } from "bun:test";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import {
    createTenexSystemReminderContext,
    getSystemReminderContext,
    runWithSystemReminderContext,
} from "../system-reminder-context";

describe("TENEX system reminder context", () => {
    afterEach(() => {
        resetSystemReminders();
    });

    test("scopes queued reminders to the active async context", async () => {
        const outerContext = createTenexSystemReminderContext();

        await runWithSystemReminderContext(async () => {
            getSystemReminderContext().queue({
                type: "outer",
                content: "outer reminder",
            });

            const innerContext = createTenexSystemReminderContext();
            await runWithSystemReminderContext(async () => {
                getSystemReminderContext().queue({
                    type: "inner",
                    content: "inner reminder",
                });

                expect(await getSystemReminderContext().collect()).toEqual([
                    { type: "inner", content: "inner reminder" },
                ]);
            }, innerContext);

            expect(await getSystemReminderContext().collect()).toEqual([
                { type: "outer", content: "outer reminder" },
            ]);
        }, outerContext);

        expect(await getSystemReminderContext().collect()).toEqual([]);
    });
});
