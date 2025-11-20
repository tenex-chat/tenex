#!/usr/bin/env bun
/**
 * Architecture Linting Script
 * Statically checks architectural boundaries and conventions
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

interface LintError {
	file: string;
	line: number;
	violation: string;
	severity: "error" | "warning";
}

const errors: LintError[] = [];
const warnings: LintError[] = [];

// ANSI colors
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

async function* getFiles(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				!entry.name.startsWith(".") &&
				entry.name !== "node_modules" &&
				entry.name !== "dist"
			) {
				yield* getFiles(path);
			}
		} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
			yield path;
		}
	}
}

function addError(error: LintError) {
	if (error.severity === "error") {
		errors.push(error);
	} else {
		warnings.push(error);
	}
}

// Rule 1: lib/ must not import from TENEX modules
async function checkLibImports(file: string, content: string) {
	if (!file.includes("/lib/")) return;

	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const importMatch = line.match(/from ['"]@\/(utils|services|agents|conversations|tools|daemon|commands|event-handler|nostr|llm|prompts)/);
		if (importMatch) {
			addError({
				file,
				line: i + 1,
				violation: `lib/ must not import from TENEX modules. Found import from @/${importMatch[1]}. Use console.error instead of logger, or move this code to utils/.`,
				severity: "error",
			});
		}
	}
}

// Rule 2: utils/ should not import from services or higher
async function checkUtilsImports(file: string, content: string) {
	if (!file.includes("/utils/")) return;

	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const importMatch = line.match(/from ['"]@\/(services|agents|conversations|tools|daemon|commands|event-handler)/);
		if (importMatch) {
			addError({
				file,
				line: i + 1,
				violation: `utils/ should not import from ${importMatch[1]}. This creates tight coupling. Consider moving this to services/ if it needs business logic.`,
				severity: "warning",
			});
		}
	}
}

// Rule 3: Check for barrel imports from services
async function checkServiceImports(file: string, content: string) {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Check for imports from @/services (barrel) instead of @/services/something
		const barrelMatch = line.match(/from ['"]@\/services['"]/);
		if (barrelMatch && !line.includes("@/services/")) {
			addError({
				file,
				line: i + 1,
				violation: `Avoid barrel imports from @/services. Import directly from subdirectories (e.g., @/services/rag) for better tree-shaking and explicit dependencies.`,
				severity: "warning",
			});
		}
	}
}

// Rule 4: Check service naming conventions
async function checkServiceNaming(file: string) {
	if (!file.includes("/services/") || file.includes("/__tests__/")) return;
	if (!file.endsWith(".ts") || file.endsWith(".test.ts")) return;

	const filename = file.split("/").pop();
	if (!filename) return;

	// Skip type files and index files
	if (filename === "types.ts" || filename === "index.ts") return;

	// Check if it's a service file that doesn't end with Service
	const isServiceFile =
		filename.includes("Service") ||
		filename.includes("Manager") ||
		filename.includes("Registry") ||
		filename.includes("Repository") ||
		filename.includes("Publisher") ||
		filename.includes("Store");

	if (isServiceFile && !filename.endsWith("Service.ts")) {
		// This is a legacy naming, suggest improvement
		const newName = filename.replace(
			/(Manager|Registry|Repository|Publisher|Store)\.ts$/,
			"Service.ts"
		);
		addError({
			file,
			line: 1,
			violation: `Service file should use "Service" suffix for consistency. Consider renaming to ${newName}`,
			severity: "warning",
		});
	}
}

// Rule 5: Check for circular dependencies (basic check)
const importGraph = new Map<string, Set<string>>();

function normalizeImport(imp: string, fromFile: string): string {
	if (imp.startsWith("@/")) {
		return imp;
	}
	// Handle relative imports
	const fromDir = fromFile.split("/").slice(0, -1).join("/");
	let resolved = imp;
	while (resolved.startsWith("../")) {
		resolved = resolved.slice(3);
	}
	if (resolved.startsWith("./")) {
		resolved = resolved.slice(2);
	}
	return `${fromDir}/${resolved}`;
}

async function buildImportGraph(file: string, content: string) {
	const lines = content.split("\n");
	const imports = new Set<string>();

	for (const line of lines) {
		const match = line.match(/from ['"](@\/[^'"]+|\.\.?\/[^'"]+)['"]/);
		if (match) {
			const imp = match[1].replace(/\.(ts|tsx)$/, "");
			imports.add(normalizeImport(imp, file));
		}
	}

	importGraph.set(file, imports);
}

function findCycles() {
	const visited = new Set<string>();
	const stack = new Set<string>();
	const cycles: string[][] = [];

	function dfs(node: string, path: string[]): void {
		if (stack.has(node)) {
			// Found a cycle
			const cycleStart = path.indexOf(node);
			if (cycleStart !== -1) {
				cycles.push(path.slice(cycleStart).concat(node));
			}
			return;
		}

		if (visited.has(node)) return;

		visited.add(node);
		stack.add(node);
		path.push(node);

		const imports = importGraph.get(node) || new Set();
		for (const imp of imports) {
			// Try to find the actual file
			for (const [file] of importGraph) {
				if (file.includes(imp.replace("@/", "src/"))) {
					dfs(file, [...path]);
				}
			}
		}

		stack.delete(node);
	}

	for (const [file] of importGraph) {
		if (!visited.has(file)) {
			dfs(file, []);
		}
	}

	return cycles;
}

// Main linting logic
async function lint() {
	console.log("🔍 Running architecture linting...\n");

	const files: string[] = [];
	for await (const file of getFiles("src")) {
		files.push(file);
	}

	console.log(`Found ${files.length} TypeScript files to check\n`);

	// Run all checks
	for (const file of files) {
		const content = await readFile(file, "utf-8");

		await checkLibImports(file, content);
		await checkUtilsImports(file, content);
		await checkServiceImports(file, content);
		await checkServiceNaming(file);
		await buildImportGraph(file, content);
	}

	// Check for circular dependencies
	const cycles = findCycles();
	for (const cycle of cycles) {
		if (cycle.length > 1) {
			addError({
				file: cycle[0],
				line: 1,
				violation: `Circular dependency detected: ${cycle.map((f) => f.split("/").slice(-1)[0]).join(" → ")}`,
				severity: "error",
			});
		}
	}

	// Print results
	if (errors.length === 0 && warnings.length === 0) {
		console.log(`${GREEN}✅ Architecture check passed!${RESET}\n`);
		console.log("All files follow architectural principles.");
		return 0;
	}

	if (errors.length > 0) {
		console.log(`${RED}❌ Architecture violations found:${RESET}\n`);
		for (const error of errors) {
			console.log(
				`${RED}ERROR${RESET} ${error.file.replace(process.cwd(), ".")}:${error.line}`
			);
			console.log(`  ${error.violation}\n`);
		}
	}

	if (warnings.length > 0) {
		console.log(`${YELLOW}⚠️  Architecture warnings:${RESET}\n`);
		for (const warning of warnings) {
			console.log(
				`${YELLOW}WARNING${RESET} ${warning.file.replace(process.cwd(), ".")}:${warning.line}`
			);
			console.log(`  ${warning.violation}\n`);
		}
	}

	console.log("\nSummary:");
	console.log(
		`${errors.length > 0 ? RED : GREEN}Errors: ${errors.length}${RESET}`
	);
	console.log(`${YELLOW}Warnings: ${warnings.length}${RESET}`);
	console.log("\nSee docs/ARCHITECTURE.md for guidelines.");

	return errors.length > 0 ? 1 : 0;
}

// Run
lint()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error("Linting failed:", err);
		process.exit(1);
	});
