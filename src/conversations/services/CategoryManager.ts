import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureDirectory, fileExists } from "@/lib/fs";

/**
 * CategoryTally represents the stored format: category name -> usage count
 * @example { "authentication": 15, "storage": 8, "testing": 12 }
 */
export type CategoryTally = Record<string, number>;

/**
 * CategoryManager - Manages conversation categories with usage tracking
 *
 * ## Responsibility
 * Maintains a tally of conversation categories stored in a local JSON file.
 * Categories track usage counts to identify frequently used categorizations.
 *
 * ## Storage Location
 * Categories are stored in `data/conversation-categories.json` relative to the
 * project root. The data directory is created automatically if it doesn't exist.
 *
 * ## Category Format Requirements
 * - Lowercase (e.g., "authentication" not "Authentication")
 * - Singular nouns (e.g., "authentication" not "auth")
 * - No special characters or spaces (e.g., "error-handling" not "error handling")
 *
 * ## Thread Safety
 * All file operations use async/await to ensure proper sequencing.
 * The class maintains no in-memory cache to avoid stale data issues.
 *
 * @example
 * const manager = new CategoryManager('/path/to/project');
 * await manager.initialize();
 *
 * // Get existing categories
 * const categories = await manager.getCategories();
 * // Returns: ["authentication", "storage", "testing"]
 *
 * // Update with new categories
 * await manager.updateCategories(["authentication", "database"]);
 * // Increments "authentication" count, adds "database" with count 1
 */
export class CategoryManager {
    private dataDir: string;
    private categoriesFilePath: string;

    /**
     * Creates a new CategoryManager instance
     * @param projectRoot - The root directory of the project
     */
    constructor(projectRoot: string) {
        this.dataDir = path.join(projectRoot, "data");
        this.categoriesFilePath = path.join(this.dataDir, "conversation-categories.json");
    }

    /**
     * Initialize the CategoryManager by ensuring the data directory exists
     */
    async initialize(): Promise<void> {
        await ensureDirectory(this.dataDir);
    }

    /**
     * Load the category tally from disk
     * @returns The current category tally, or empty object if file doesn't exist
     */
    private async loadTally(): Promise<CategoryTally> {
        try {
            if (!(await fileExists(this.categoriesFilePath))) {
                return {};
            }
            const content = await fs.readFile(this.categoriesFilePath, "utf-8");
            return JSON.parse(content) as CategoryTally;
        } catch (error) {
            // If file is corrupted or unreadable, start fresh
            console.error("Failed to load category tally, starting fresh:", error);
            return {};
        }
    }

    /**
     * Save the category tally to disk
     * @param tally - The category tally to save
     */
    private async saveTally(tally: CategoryTally): Promise<void> {
        await ensureDirectory(this.dataDir);
        await fs.writeFile(this.categoriesFilePath, JSON.stringify(tally, null, 2), "utf-8");
    }

    /**
     * Get all existing categories as an array
     * Categories are sorted by usage count (highest first)
     * @returns Array of category names
     */
    async getCategories(): Promise<string[]> {
        const tally = await this.loadTally();
        // Sort by usage count (descending) to prioritize frequently used categories
        return Object.entries(tally)
            .sort(([, countA], [, countB]) => countB - countA)
            .map(([category]) => category);
    }

    /**
     * Get the full category tally including usage counts
     * @returns The category tally object
     */
    async getCategoryTally(): Promise<CategoryTally> {
        return this.loadTally();
    }

    /**
     * Update categories by adding new ones and incrementing counts for existing ones
     *
     * @param newCategories - Array of category names to add/increment
     *
     * @example
     * // If tally is { "authentication": 5, "storage": 2 }
     * await manager.updateCategories(["authentication", "database"]);
     * // Tally becomes { "authentication": 6, "storage": 2, "database": 1 }
     */
    async updateCategories(newCategories: string[]): Promise<void> {
        if (newCategories.length === 0) {
            return;
        }

        const tally = await this.loadTally();

        for (const category of newCategories) {
            // Normalize: lowercase, trim whitespace
            const normalizedCategory = category.toLowerCase().trim();

            if (!normalizedCategory) {
                continue;
            }

            // Increment existing or initialize to 1
            tally[normalizedCategory] = (tally[normalizedCategory] || 0) + 1;
        }

        await this.saveTally(tally);
    }

    /**
     * Remove a category from the tally
     * @param category - The category to remove
     * @returns true if the category was removed, false if it didn't exist
     */
    async removeCategory(category: string): Promise<boolean> {
        const tally = await this.loadTally();
        const normalizedCategory = category.toLowerCase().trim();

        if (!(normalizedCategory in tally)) {
            return false;
        }

        delete tally[normalizedCategory];
        await this.saveTally(tally);
        return true;
    }
}
