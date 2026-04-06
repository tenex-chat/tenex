export type MigrationVersion = number | "unknown";

export interface MigrationRunResult {
    migratedCount: number;
    skippedCount: number;
    warnings: string[];
}

export interface AppliedMigration {
    from: MigrationVersion;
    to: number;
    description: string;
    result: MigrationRunResult;
}

export interface StateMigration {
    from: MigrationVersion;
    to: number;
    description: string;
    run: () => Promise<MigrationRunResult>;
}

export interface MigrationSummary {
    currentVersion: MigrationVersion;
    latestVersion: number;
    applied: AppliedMigration[];
    finalVersion: MigrationVersion;
}
