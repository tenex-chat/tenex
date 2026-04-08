import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextManagementReminder, ReminderPlacement } from "ai-sdk-context-management";
import { trace } from "@opentelemetry/api";

export interface TenexSystemReminderDescriptor {
    type: string;
    content: string;
    attributes?: Record<string, string>;
    placement?: ReminderPlacement;
    persistInHistory?: boolean;
}

export interface CollectedSystemReminder extends TenexSystemReminderDescriptor {
    disposition?: ContextManagementReminder["disposition"];
}

export interface TenexSystemReminderContext {
    queue(reminder: TenexSystemReminderDescriptor): void;
    defer(reminder: TenexSystemReminderDescriptor): void;
    advance(): void;
    collect(): Promise<CollectedSystemReminder[]>;
    clear(): void;
}

interface ReminderQueues {
    queued: CollectedSystemReminder[];
    deferred: CollectedSystemReminder[];
}

function descriptorToCollected(reminder: TenexSystemReminderDescriptor): CollectedSystemReminder {
    return {
        type: reminder.type,
        content: reminder.content,
        placement: reminder.placement ?? "overlay-user",
        ...(reminder.attributes ? { attributes: reminder.attributes } : {}),
        ...(reminder.persistInHistory !== undefined ? { persistInHistory: reminder.persistInHistory } : {}),
    };
}

function buildReminderContext(): TenexSystemReminderContext {
    const queues: ReminderQueues = {
        queued: [],
        deferred: [],
    };

    return {
        queue(reminder) {
            queues.queued.push(descriptorToCollected(reminder));
        },
        defer(reminder) {
            queues.deferred.push({
                ...descriptorToCollected(reminder),
                disposition: "defer",
            });
        },
        advance() {
            if (queues.deferred.length === 0) {
                return;
            }

            queues.queued.push(...queues.deferred.map((r) => structuredClone(r)));
            queues.deferred.length = 0;
        },
        async collect() {
            const reminders = queues.queued.map((r) => structuredClone(r));
            queues.queued.length = 0;

            trace.getActiveSpan()?.addEvent("system_reminders.collected", {
                "reminder.count": reminders.length,
                "reminder.types": reminders.map((reminder) => reminder.type).join(","),
            });

            return reminders;
        },
        clear() {
            queues.queued.length = 0;
            queues.deferred.length = 0;
        },
    };
}

const reminderContextStorage = new AsyncLocalStorage<TenexSystemReminderContext>();
const fallbackContext = buildReminderContext();

export function createTenexSystemReminderContext(): TenexSystemReminderContext {
    return buildReminderContext();
}

export function runWithSystemReminderContext<T>(
    callback: () => Promise<T> | T,
    context: TenexSystemReminderContext = createTenexSystemReminderContext()
): Promise<T> | T {
    return reminderContextStorage.run(context, callback);
}

export function getSystemReminderContext(): TenexSystemReminderContext {
    return reminderContextStorage.getStore() ?? fallbackContext;
}
