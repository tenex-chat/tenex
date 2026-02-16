/**
 * Skill Event Types
 *
 * Defines the structure for skill events (kind:4202).
 * Skills are transient capabilities that can be injected into agent system prompts.
 *
 * Unlike nudges, skills do NOT have tool permissions (only-tool, allow-tool, deny-tool).
 * Skills are focused on providing additional context, instructions, and attached files.
 */

/**
 * Information about a file attached to a skill via NIP-94 (kind 1063) event reference
 */
export interface SkillFileInfo {
    /** Event ID of the kind:1063 event */
    eventId: string;
    /** Blossom URL to download the file */
    url: string;
    /** Relative path where the file should be stored (from NIP-94 "name" tag) */
    relativePath: string;
    /** Optional MIME type (from NIP-94 "m" tag) */
    mimeType?: string;
    /** Optional SHA-256 hash for verification (from NIP-94 "x" tag) */
    sha256?: string;
}

/**
 * Result of downloading and installing a skill file
 */
export interface SkillFileInstallResult {
    /** Event ID of the source kind:1063 event */
    eventId: string;
    /** Relative path within the skill directory */
    relativePath: string;
    /** Absolute path where the file was installed */
    absolutePath: string;
    /** Whether the installation succeeded */
    success: boolean;
    /** Error message if installation failed */
    error?: string;
}

/**
 * Individual skill data with content, title, and attached files
 */
export interface SkillData {
    /** The skill content/instructions */
    content: string;
    /** The skill title (from "title" tag) */
    title?: string;
    /** The skill name/identifier (from "name" tag) */
    name?: string;
    /** Short ID for directory naming (first 12 chars of event ID) */
    shortId: string;
    /** List of installed files for this skill */
    installedFiles: SkillFileInstallResult[];
}

/**
 * Result from fetching skills with their attached files.
 * Contains both the concatenated content for system prompt injection
 * and the individual skill data with file information.
 */
export interface SkillResult {
    /** Individual skill data for rendering in the fragment */
    skills: SkillData[];

    /** Concatenated content from all skills (for backward compatibility) */
    content: string;
}
