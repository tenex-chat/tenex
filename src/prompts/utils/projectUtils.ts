import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@/utils/logger";

/**
 * Count total files in a directory recursively, excluding dot files and node_modules
 */
export function countTotalFiles(dir: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
        if (entry.isDirectory()) {
          count += countTotalFiles(path.join(dir, entry.name));
        } else {
          count += 1;
        }
      }
    }
  } catch (error) {
    logger.debug(`Could not count files in ${dir}`, { error });
  }
  return count;
}