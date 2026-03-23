import { createMessageSanitizerMiddleware as createSanitizer } from "ai-sdk-message-sanitizer";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";

function writeWarnLog(entry: Record<string, unknown>): void {
    try {
        const dir = join(getTenexBasePath(), "daemon");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "warn.log"), `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
        // Best-effort logging — never let warn logging crash the LLM call
    }
}

export function createMessageSanitizerMiddleware() {
    return createSanitizer({
        onFix: writeWarnLog,
    });
}
