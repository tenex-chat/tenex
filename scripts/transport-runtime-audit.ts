import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();
const srcRoot = join(repoRoot, "src");

const concreteImportNeedle = `@/nostr/AgentPublisher`;
const interfaceImportNeedle = `@/events/runtime/AgentRuntimePublisher`;
const dispatchImportNeedle = `@/services/dispatch/AgentDispatchService`;

const allowedConcreteImports = new Set([
    "src/agents/execution/AgentExecutor.ts",
    "src/nostr/AgentPublisher.ts",
]);
const allowedDispatchImports = new Set([
    "src/tools/implementations/kill.ts",
]);

type AuditSummary = {
    concreteImports: string[];
    interfaceImports: string[];
    dispatchImports: string[];
    unexpectedConcreteImports: string[];
    unexpectedDispatchImports: string[];
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
            !fullPath.includes(`${join("src", "test-utils")}`) &&
            !fullPath.endsWith("AGENTS.md")
        ) {
            files.push(fullPath);
        }
    }

    return files;
}

function buildSummary(): AuditSummary {
    const files = walk(srcRoot);
    const concreteImports: string[] = [];
    const interfaceImports: string[] = [];
    const dispatchImports: string[] = [];

    for (const file of files) {
        const content = readFileSync(file, "utf8");
        const relPath = relative(repoRoot, file);

        if (content.includes(concreteImportNeedle)) {
            concreteImports.push(relPath);
        }

        if (content.includes(interfaceImportNeedle)) {
            interfaceImports.push(relPath);
        }

        if (content.includes(dispatchImportNeedle)) {
            dispatchImports.push(relPath);
        }

    }

    const unexpectedConcreteImports = concreteImports.filter(
        (file) => !allowedConcreteImports.has(file)
    );
    const unexpectedDispatchImports = dispatchImports.filter(
        (file) => !allowedDispatchImports.has(file) && file !== "src/services/dispatch/AgentDispatchService.ts"
    );
    return {
        concreteImports: concreteImports.sort(),
        interfaceImports: interfaceImports.sort(),
        dispatchImports: dispatchImports.sort(),
        unexpectedConcreteImports: unexpectedConcreteImports.sort(),
        unexpectedDispatchImports: unexpectedDispatchImports.sort(),
    };
}

function printSummary(summary: AuditSummary): void {
    const status =
        summary.unexpectedConcreteImports.length === 0 &&
        summary.unexpectedDispatchImports.length === 0
            ? "PASS"
            : "FAIL";

    console.log("Transport Runtime Audit");
    console.log("=======================");
    console.log(`Status: ${status}`);
    console.log(`Concrete AgentPublisher imports: ${summary.concreteImports.length}`);
    console.log(`AgentRuntimePublisher imports: ${summary.interfaceImports.length}`);
    console.log(`AgentDispatchService imports: ${summary.dispatchImports.length}`);
    console.log("");

    if (summary.concreteImports.length > 0) {
        console.log("Concrete imports:");
        for (const file of summary.concreteImports) {
            const marker = allowedConcreteImports.has(file) ? "allowed" : "unexpected";
            console.log(`- ${file} (${marker})`);
        }
        console.log("");
    }

    if (summary.interfaceImports.length > 0) {
        console.log("Interface imports:");
        for (const file of summary.interfaceImports) {
            console.log(`- ${file}`);
        }
        console.log("");
    }

    if (summary.dispatchImports.length > 0) {
        console.log("Dispatch imports:");
        for (const file of summary.dispatchImports) {
            const marker = allowedDispatchImports.has(file) || file === "src/services/dispatch/AgentDispatchService.ts"
                ? "allowed"
                : "unexpected";
            console.log(`- ${file} (${marker})`);
        }
        console.log("");
    }

    console.log("JSON Summary:");
    console.log(JSON.stringify(summary, null, 2));
}

const summary = buildSummary();
printSummary(summary);

if (
    process.argv.includes("--strict") &&
    (
        summary.unexpectedConcreteImports.length > 0 ||
        summary.unexpectedDispatchImports.length > 0
    )
) {
    process.exit(1);
}
