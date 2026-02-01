/**
 * Formatters for heuristic violations
 *
 * Converts violations into markdown warnings for LLM context
 */

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
 * Format multiple violations into a single system reminder block
 *
 * @param violations - List of violations to format (max 3 recommended)
 * @returns Markdown string ready for LLM injection
 */
export function formatViolations(violations: HeuristicViolation[]): string {
  if (violations.length === 0) {
    return "";
  }

  const formattedViolations = violations.map(formatViolation).join("\n\n---\n\n");

  return [
    "# 🔍 Heuristic Reminders",
    "",
    "The following pattern violations were detected based on your recent actions:",
    "",
    formattedViolations,
    "",
    "Please address these before continuing.",
  ].join("\n");
}

/**
 * Format a violation for debug logging (single line)
 */
export function formatViolationForLog(violation: HeuristicViolation): string {
  return `[${violation.severity}] ${violation.heuristicId}: ${violation.title}`;
}
