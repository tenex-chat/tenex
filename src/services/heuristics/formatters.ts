/**
 * Formatters for heuristic violations
 *
 * Converts violations into markdown warnings for LLM context.
 * Output is wrapped in <system-reminder> tags for consistent injection.
 */

import { wrapInSystemReminder } from "@/services/system-reminder";
import type { HeuristicViolation } from "./types";

/**
 * Format a single violation as a markdown warning block
 */
export function formatViolation(violation: HeuristicViolation): string {
  const icon = violation.severity === "error" ? "🚨" : "⚠️";
  const severityLabel = violation.severity.toUpperCase();

  return [
    `${icon} **${severityLabel}: ${violation.title}**`,
    "",
    violation.message,
  ].join("\n");
}

/**
 * Format multiple violations into a single system reminder block.
 * Output is wrapped in <system-reminder> tags for consistent injection
 * and appending to user messages.
 *
 * @param violations - List of violations to format (max 3 recommended)
 * @returns Content wrapped in system-reminder tags, ready for injection
 */
export function formatViolations(violations: HeuristicViolation[]): string {
  if (violations.length === 0) {
    return "";
  }

  const formattedViolations = violations.map(formatViolation).join("\n\n---\n\n");

  const content = [
    "# Heuristic Reminders",
    "",
    "The following pattern violations were detected based on your recent actions:",
    "",
    formattedViolations,
    "",
    "Please address these before continuing.",
  ].join("\n");

  return wrapInSystemReminder(content);
}

/**
 * Format a violation for debug logging (single line)
 */
export function formatViolationForLog(violation: HeuristicViolation): string {
  return `[${violation.severity}] ${violation.heuristicId}: ${violation.title}`;
}
