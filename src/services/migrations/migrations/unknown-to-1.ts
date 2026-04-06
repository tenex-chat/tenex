import * as fs from "node:fs/promises";
import { agentStorage } from "@/agents/AgentStorage";
import { fileExists, readJsonFile, writeJsonFile } from "@/lib/fs";
import {
    getLegacySchedulesPath,
    getProjectSchedulesPath,
    normalizeProjectIdForRuntime,
} from "@/services/scheduling";
import type { LegacyScheduledTask, ScheduledTask } from "@/services/scheduling";
import { logger } from "@/utils/logger";
import type { MigrationRunResult, StateMigration } from "../types";

export const unknownTo1Migration: StateMigration = {
    from: "unknown",
    to: 1,
    description: "Relocate legacy schedules into per-project schedules.json files",
    run: migrateUnknownTo1,
};

async function migrateUnknownTo1(): Promise<MigrationRunResult> {
    const legacyPath = getLegacySchedulesPath();
    if (!(await fileExists(legacyPath))) {
        return {
            migratedCount: 0,
            skippedCount: 0,
            warnings: [],
        };
    }

    const legacyTasks = await readJsonFile<LegacyScheduledTask[]>(legacyPath);
    if (!Array.isArray(legacyTasks)) {
        throw new Error(`Legacy schedules file is invalid: ${legacyPath}`);
    }

    await agentStorage.initialize();

    const pubkeyToSlug = new Map<string, string | null>();
    const pubkeyToProjects = new Map<string, string[]>();
    const tasksByProject = new Map<string, ScheduledTask[]>();
    const warnings: string[] = [];
    let migratedCount = 0;
    let skippedCount = 0;

    for (const legacyTask of legacyTasks) {
        const projectId = normalizeProjectIdForRuntime(legacyTask.projectId);
        const targetAgentSlug = await resolveTargetAgentSlug(
            legacyTask.toPubkey,
            projectId,
            pubkeyToSlug,
            pubkeyToProjects
        );

        if (!targetAgentSlug) {
            skippedCount++;
            warnings.push(
                `Skipped schedule ${legacyTask.id}: could not resolve ${legacyTask.toPubkey.substring(0, 8)} to a project agent slug for ${projectId}.`
            );
            continue;
        }

        const migratedTask: ScheduledTask = {
            id: legacyTask.id,
            title: legacyTask.title,
            schedule: legacyTask.schedule,
            prompt: legacyTask.prompt,
            lastRun: legacyTask.lastRun,
            nextRun: legacyTask.nextRun,
            createdAt: legacyTask.createdAt,
            fromPubkey: legacyTask.fromPubkey,
            targetAgentSlug,
            projectId,
            projectRef: legacyTask.projectRef ?? legacyTask.projectId,
            type: legacyTask.type,
            executeAt: legacyTask.executeAt,
            targetChannel: legacyTask.targetChannel,
        };

        const existing = tasksByProject.get(projectId) ?? [];
        existing.push(migratedTask);
        tasksByProject.set(projectId, existing);
        migratedCount++;
    }

    for (const [projectId, migratedTasks] of tasksByProject.entries()) {
        const filePath = getProjectSchedulesPath(projectId);
        const existingTasks = await readJsonFile<ScheduledTask[]>(filePath);
        const merged = new Map<string, ScheduledTask>();

        if (Array.isArray(existingTasks)) {
            for (const task of existingTasks) {
                merged.set(task.id, task);
            }
        }

        for (const task of migratedTasks) {
            merged.set(task.id, task);
        }

        await writeJsonFile(
            filePath,
            Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id))
        );
    }

    if (skippedCount === 0) {
        await fs.unlink(legacyPath);
    } else {
        warnings.push(
            `Legacy schedule file retained at ${legacyPath} because ${skippedCount} task(s) could not be migrated safely.`
        );
    }

    logger.info("[MigrationService] Applied schedule migration", {
        migratedCount,
        skippedCount,
        projects: Array.from(tasksByProject.keys()),
    });

    return {
        migratedCount,
        skippedCount,
        warnings,
    };
}

async function resolveTargetAgentSlug(
    pubkey: string,
    projectId: string,
    pubkeyToSlug: Map<string, string | null>,
    pubkeyToProjects: Map<string, string[]>
): Promise<string | null> {
    if (!pubkeyToSlug.has(pubkey)) {
        const agent = await agentStorage.loadAgent(pubkey);
        pubkeyToSlug.set(pubkey, agent?.slug ?? null);
    }

    const slug = pubkeyToSlug.get(pubkey) ?? null;
    if (!slug) {
        return null;
    }

    if (!pubkeyToProjects.has(pubkey)) {
        const projectIds = await agentStorage.getAgentProjects(pubkey);
        pubkeyToProjects.set(
            pubkey,
            projectIds.map((value) => normalizeProjectIdForRuntime(value))
        );
    }

    const projectIds = pubkeyToProjects.get(pubkey) ?? [];
    if (!projectIds.includes(projectId)) {
        return null;
    }

    return slug;
}
