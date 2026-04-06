import * as path from "node:path";
import { config } from "@/services/ConfigService";
import { tryExtractDTagFromAddress } from "@/types/project-ids";

export const LEGACY_SCHEDULES_FILE = "scheduled_tasks.json";
export const PROJECT_SCHEDULES_FILE = "schedules.json";

export function normalizeProjectIdForRuntime(projectId: string): string {
    return tryExtractDTagFromAddress(projectId) ?? projectId;
}

export function getLegacySchedulesPath(): string {
    return path.join(config.getConfigPath(), LEGACY_SCHEDULES_FILE);
}

export function getProjectSchedulesPath(projectId: string): string {
    return path.join(
        config.getProjectMetadataPath(normalizeProjectIdForRuntime(projectId)),
        PROJECT_SCHEDULES_FILE
    );
}
