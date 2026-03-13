/**
 * Formatters for heuristic violations
 *
 * Converts violations into markdown warnings for LLM context.
 * Output is wrapped in typed <system-reminder type="{heuristicId}"> tags for consistent injection.
 */

import { wrapInSystemReminder } from "ai-sdk-system-reminders";
import type { SystemReminderDescriptor } from "ai-sdk-system-reminders";
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
 * Create individual system reminder descriptors per heuristic violation.
 * Each violation gets its own reminder with type = heuristicId.
 *
 * @param violations - List of violations to format
 * @returns Array of system reminder descriptors, one per violation
 */
export function createViolationReminders(
  violations: HeuristicViolation[]
): SystemReminderDescriptor[] {
  return violations.map((violation) => ({
    type: violation.heuristicId,
    content: formatViolation(violation),
  }));
}

export function formatViolations(violations: HeuristicViolation[]): string {
  const reminders = createViolationReminders(violations);

  if (reminders.length === 0) {
    return "";
  }

  return reminders.map((r) => wrapInSystemReminder(r)).join("\n\n");
}

/**
 * Format a violation for debug logging (single line)
 */
export function formatViolationForLog(violation: HeuristicViolation): string {
  return `[${violation.severity}] ${violation.heuristicId}: ${violation.title}`;
}
