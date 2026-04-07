import { config } from "@/services/ConfigService";
import { unknownTo1Migration } from "./migrations/unknown-to-1";
import { migration1To2 } from "./migrations/1-to-2";
import type {
    AppliedMigration,
    MigrationSummary,
    MigrationVersion,
    StateMigration,
} from "./types";

const MIGRATIONS: StateMigration[] = [unknownTo1Migration, migration1To2];
const LATEST_MIGRATION_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.to ?? 0;

export class MigrationService {
    async migrate(): Promise<MigrationSummary> {
        const globalPath = config.getGlobalPath();
        const loadedConfig = await config.loadTenexConfig(globalPath);
        const initialVersion = this.getCurrentVersion(loadedConfig.version);
        const applied: AppliedMigration[] = [];
        let currentVersion = initialVersion;

        for (const migration of this.getPendingMigrations(currentVersion)) {
            const result = await migration.run();
            loadedConfig.version = migration.to;
            await config.saveGlobalConfig(loadedConfig);
            currentVersion = migration.to;
            applied.push({
                from: migration.from,
                to: migration.to,
                description: migration.description,
                result,
            });
        }

        return {
            currentVersion: initialVersion,
            latestVersion: LATEST_MIGRATION_VERSION,
            applied,
            finalVersion: currentVersion,
        };
    }

    getLatestVersion(): number {
        return LATEST_MIGRATION_VERSION;
    }

    private getCurrentVersion(version: number | undefined): MigrationVersion {
        return typeof version === "number" ? version : "unknown";
    }

    private getPendingMigrations(from: MigrationVersion): StateMigration[] {
        const pending: StateMigration[] = [];
        let current = from;

        while (true) {
            const migration = MIGRATIONS.find((candidate) => candidate.from === current);
            if (!migration) {
                if (current === LATEST_MIGRATION_VERSION) {
                    return pending;
                }
                if (typeof current === "number" && current > LATEST_MIGRATION_VERSION) {
                    return pending;
                }
                if (current === "unknown" && LATEST_MIGRATION_VERSION === 0) {
                    return pending;
                }
                throw new Error(`No migration path found from version ${String(current)}`);
            }

            pending.push(migration);
            current = migration.to;
        }
    }
}

export const migrationService = new MigrationService();
