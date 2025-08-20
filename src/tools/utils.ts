import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves and validates a file path to ensure it stays within the project boundaries.
 *
 * @param filePath - The file path to validate (can be absolute or relative)
 * @param projectPath - The root project path
 * @returns The resolved absolute path if valid
 * @throws Error if the path would escape the project directory
 */
export function resolveAndValidatePath(filePath: string, projectPath: string): string {
  const fullPath = isAbsolute(filePath) ? filePath : resolve(projectPath, filePath);
  const relativePath = relative(projectPath, fullPath);

  if (relativePath.startsWith("..")) {
    throw new Error(`Path outside project directory: ${filePath}`);
  }

  return fullPath;
}
