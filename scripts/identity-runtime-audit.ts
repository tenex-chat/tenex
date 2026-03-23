import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, "src");

const pubkeyImportNeedle = `@/services/PubkeyService`;
const identityImportNeedle = `@/services/identity`;

const targetRoots = [
    "src/agents/execution",
    "src/conversations",
    "src/prompts/fragments",
    "src/prompts/utils",
];

const allowedPubkeyImports = new Set([
    "src/prompts/fragments/07-meta-project-context.ts",
]);

type AuditSummary = {
    pubkeyImports: string[];
    identityImports: string[];
    unexpectedPubkeyImports: string[];
};

function walk(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            files.push(...walk(fullPath));
            continue;
        }

        if (
            fullPath.endsWith(".ts") &&
            !fullPath.endsWith(".test.ts") &&
            !fullPath.endsWith("AGENTS.md")
        ) {
            files.push(fullPath);
        }
    }

    return files;
}

function buildSummary(): AuditSummary {
    const files = targetRoots.flatMap((root) => walk(join(repoRoot, root)));
    const pubkeyImports: string[] = [];
    const identityImports: string[] = [];

    for (const file of files) {
        const content = readFileSync(file, "utf8");
        const relPath = relative(repoRoot, file);

        if (content.includes(pubkeyImportNeedle)) {
            pubkeyImports.push(relPath);
        }

        if (content.includes(identityImportNeedle)) {
            identityImports.push(relPath);
        }
    }

    const unexpectedPubkeyImports = pubkeyImports.filter(
        (file) => !allowedPubkeyImports.has(file)
    );

    return {
        pubkeyImports: pubkeyImports.sort(),
        identityImports: identityImports.sort(),
        unexpectedPubkeyImports: unexpectedPubkeyImports.sort(),
    };
}

function printSummary(summary: AuditSummary): void {
    const status = summary.unexpectedPubkeyImports.length === 0 ? "PASS" : "FAIL";

    console.log("Identity Runtime Audit");
    console.log("======================");
    console.log(`Status: ${status}`);
    console.log(`Direct PubkeyService imports: ${summary.pubkeyImports.length}`);
    console.log(`IdentityService imports: ${summary.identityImports.length}`);
    console.log("");

    if (summary.pubkeyImports.length > 0) {
        console.log("Direct PubkeyService imports:");
        for (const file of summary.pubkeyImports) {
            const marker = allowedPubkeyImports.has(file) ? "allowed" : "unexpected";
            console.log(`- ${file} (${marker})`);
        }
        console.log("");
    }

    if (summary.identityImports.length > 0) {
        console.log("IdentityService imports:");
        for (const file of summary.identityImports) {
            console.log(`- ${file}`);
        }
        console.log("");
    }

    console.log("JSON Summary:");
    console.log(JSON.stringify(summary, null, 2));
}

const summary = buildSummary();
printSummary(summary);

if (process.argv.includes("--strict") && summary.unexpectedPubkeyImports.length > 0) {
    process.exit(1);
}
