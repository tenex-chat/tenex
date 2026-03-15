import { createMessageSanitizerMiddleware as createSanitizer } from "ai-sdk-message-sanitizer";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getTenexBasePath } from "@/constants";

export function createMessageSanitizerMiddleware() {
    return createSanitizer({
        onFix: (entry) => {
            try {
                const dir = join(getTenexBasePath(), "daemon");
                mkdirSync(dir, { recursive: true });
                appendFileSync(join(dir, "warn.log"), JSON.stringify(entry) + "\n", "utf-8");
            } catch {
                // Best-effort logging — never let warn logging crash the LLM call
            }
        },
    });
}
