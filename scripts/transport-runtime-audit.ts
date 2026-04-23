import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const concreteImportNeedle = `@/nostr/AgentPublisher`;
const interfaceImportNeedle = `@/events/runtime/AgentRuntimePublisher`;
const directPublishPattern = /(?:\bNDKEvent\s*\.\s*prototype\s*\.\s*publish\b|\.\s*publish\s*\()/;

const allowedConcreteImports = new Set([
    "src/agents/execution/AgentExecutor.ts",
    "src/nostr/AgentPublisher.ts",
]);
const allowedDirectPublishFiles = new Set([
    "src/skills/built-in/report/scripts/publish.js",
]);

type DirectPublishCall = {
    file: string;
    line: number;
    text: string;
};

type AuditSummary = {
    concreteImports: string[];
    interfaceImports: string[];
    directPublishCalls: DirectPublishCall[];
    unexpectedConcreteImports: string[];
    unexpectedDirectPublishCalls: DirectPublishCall[];
};

type AuditOptions = {
    repoRoot?: string;
    srcRoot?: string;
};

function normalizePath(path: string): string {
    return path.replaceAll("\\", "/");
}

function isAuditedSourceFile(fullPath: string): boolean {
    return (
        (fullPath.endsWith(".ts") || fullPath.endsWith(".js")) &&
        !fullPath.endsWith(".d.ts") &&
        !fullPath.endsWith(".test.ts") &&
        !fullPath.endsWith(".spec.ts") &&
        !fullPath.includes(`${join("src", "test-utils")}`) &&
        !fullPath.includes(`${join("__tests__")}`) &&
        !fullPath.endsWith("AGENTS.md")
    );
}

function isRuntimeTypescriptFile(fullPath: string): boolean {
    return fullPath.endsWith(".ts") && isAuditedSourceFile(fullPath);
}

function walk(dir: string, includeFile: (fullPath: string) => boolean): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            files.push(...walk(fullPath, includeFile));
            continue;
        }

        if (includeFile(fullPath)) {
            files.push(fullPath);
        }
    }

    return files;
}

function findDirectPublishCalls(repoRoot: string, file: string): DirectPublishCall[] {
    const relPath = normalizePath(relative(repoRoot, file));
    const content = readFileSync(file, "utf8");
    const calls: DirectPublishCall[] = [];

    content.split(/\r?\n/).forEach((line, index) => {
        if (directPublishPattern.test(line)) {
            calls.push({
                file: relPath,
                line: index + 1,
                text: line.trim(),
            });
        }
    });

    return calls;
}

export function buildSummary(options: AuditOptions = {}): AuditSummary {
    const repoRoot = options.repoRoot ?? process.cwd();
    const srcRoot = options.srcRoot ?? join(repoRoot, "src");
    const runtimeTypescriptFiles = walk(srcRoot, isRuntimeTypescriptFile);
    const sourceFiles = walk(srcRoot, isAuditedSourceFile);
    const concreteImports: string[] = [];
    const interfaceImports: string[] = [];
    const directPublishCalls = sourceFiles.flatMap((file) => findDirectPublishCalls(repoRoot, file));

    for (const file of runtimeTypescriptFiles) {
        const content = readFileSync(file, "utf8");
        const relPath = normalizePath(relative(repoRoot, file));

        if (content.includes(concreteImportNeedle)) {
            concreteImports.push(relPath);
        }

        if (content.includes(interfaceImportNeedle)) {
            interfaceImports.push(relPath);
        }
    }

    const unexpectedConcreteImports = concreteImports.filter(
        (file) => !allowedConcreteImports.has(file)
    );
    const unexpectedDirectPublishCalls = directPublishCalls.filter(
        (call) => !allowedDirectPublishFiles.has(call.file)
    );

    return {
        concreteImports: concreteImports.sort(),
        interfaceImports: interfaceImports.sort(),
        directPublishCalls: directPublishCalls.sort((a, b) =>
            `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)
        ),
        unexpectedConcreteImports: unexpectedConcreteImports.sort(),
        unexpectedDirectPublishCalls: unexpectedDirectPublishCalls.sort((a, b) =>
            `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)
        ),
    };
}

export function hasAuditFailures(summary: AuditSummary): boolean {
    return (
        summary.unexpectedConcreteImports.length > 0 ||
        summary.unexpectedDirectPublishCalls.length > 0
    );
}

export function printSummary(summary: AuditSummary): void {
    const status =
        !hasAuditFailures(summary)
            ? "PASS"
            : "FAIL";

    console.log("Transport Runtime Audit");
    console.log("=======================");
    console.log(`Status: ${status}`);
    console.log(`Concrete AgentPublisher imports: ${summary.concreteImports.length}`);
    console.log(`AgentRuntimePublisher imports: ${summary.interfaceImports.length}`);
    console.log(`Direct NDK publish calls: ${summary.directPublishCalls.length}`);
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

    if (summary.directPublishCalls.length > 0) {
        console.log("Direct NDK publish calls:");
        for (const call of summary.directPublishCalls) {
            const marker = allowedDirectPublishFiles.has(call.file) ? "allowed" : "unexpected";
            console.log(`- ${call.file}:${call.line} (${marker}) ${call.text}`);
        }
        console.log("");
    }

    console.log("JSON Summary:");
    console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.main) {
    const summary = buildSummary();
    printSummary(summary);

    if (process.argv.includes("--strict") && hasAuditFailures(summary)) {
        process.exit(1);
    }
}
