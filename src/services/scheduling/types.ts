export type ScheduledTaskType = "cron" | "oneoff";

export interface ScheduledTask {
    id: string;
    title?: string;
    schedule: string;
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    createdAt?: string;
    fromPubkey: string;
    targetAgentSlug: string;
    projectId: string;
    projectRef?: string;
    type?: ScheduledTaskType;
    executeAt?: string;
    targetChannel?: string;
}

export interface LegacyScheduledTask {
    id: string;
    title?: string;
    schedule: string;
    prompt: string;
    lastRun?: string;
    nextRun?: string;
    createdAt?: string;
    fromPubkey: string;
    toPubkey: string;
    projectId: string;
    projectRef?: string;
    type?: ScheduledTaskType;
    executeAt?: string;
    targetChannel?: string;
}
