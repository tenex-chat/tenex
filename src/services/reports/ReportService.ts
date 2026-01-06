import type { AgentInstance } from "@/agents/types";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

export interface ReportData {
    slug: string;
    title: string;
    summary: string;
    content: string;
    hashtags?: string[];
    memorize?: boolean;
}

export interface ReportInfo {
    id: string;
    slug: string;
    title?: string;
    summary?: string;
    content?: string;
    author: string;
    publishedAt?: number;
    hashtags?: string[];
    projectReference?: string;
    isDeleted?: boolean;
    isMemorized?: boolean;
}

export interface ReportSummary {
    id: string;
    slug: string;
    title?: string;
    summary?: string;
    author: string;
    publishedAt?: number;
    hashtags?: string[];
}

type ReportAuthor = Pick<AgentInstance, "pubkey" | "signer" | "sign">;

/**
 * Centralized service for managing NDKArticle reports
 * Handles creation, reading, listing, and deletion of reports
 */
export class ReportService {
    private ndk: NDK;

    constructor(ndk?: NDK) {
        const ndkInstance = ndk || getNDK();
        if (!ndkInstance) {
            throw new Error("NDK instance not available");
        }
        this.ndk = ndkInstance;
    }

    /**
     * Write or update a report
     */
    async writeReport(data: ReportData, agent: ReportAuthor): Promise<string> {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        if (!agent.signer) {
            throw new Error("Agent signer required to publish reports");
        }

        const article = new NDKArticle(this.ndk);

        // Set the d-tag explicitly to the provided slug
        article.dTag = data.slug;

        // Set article properties
        article.title = data.title;
        article.summary = data.summary;
        article.content = data.content;
        article.published_at = Math.floor(Date.now() / 1000);

        // Add hashtags if provided
        if (data.hashtags && data.hashtags.length > 0) {
            article.tags.push(...data.hashtags.map((tag) => ["t", tag]));
        }

        // Add memorize tag if requested - this marks the report for system prompt injection
        if (data.memorize) {
            article.tags.push(["t", "memorize"]);
        }

        // Tag the current project using a-tag
        const projectTagId = projectCtx.project.tagId();
        article.tags.push(["a", projectTagId]);

        // Add author tag for the agent
        article.tags.push(["p", agent.pubkey, "", "author"]);

        // Sign and publish the article
        await agent.sign(article);
        await article.publish();

        // Return the encoded article ID
        return article.encode();
    }

    /**
     * Read a report by slug or naddr
     * First tries the cache, then falls back to NDK fetch if not found
     */
    async readReport(identifier: string, agentPubkey?: string): Promise<ReportInfo | null> {
        const projectCtx = getProjectContext();

        // First, try to find in cache
        if (identifier.startsWith("naddr1")) {
            // Decode the naddr to extract slug and author
            const decoded = nip19.decode(identifier);
            if (decoded.type === "naddr" && decoded.data.kind === 30023) {
                const cachedReport = projectCtx.getReport(decoded.data.pubkey, decoded.data.identifier);
                if (cachedReport) {
                    logger.debug("📰 Report found in cache (by naddr)", { slug: decoded.data.identifier });
                    return cachedReport;
                }
            }
        } else if (agentPubkey) {
            // Try cache lookup by agent pubkey and slug
            const cachedReport = projectCtx.getReport(agentPubkey, identifier);
            if (cachedReport) {
                logger.debug("📰 Report found in cache (by slug)", { slug: identifier });
                return cachedReport;
            }
        } else {
            // Try to find by slug across all authors
            const cachedReport = projectCtx.getReportBySlug(identifier);
            if (cachedReport) {
                logger.debug("📰 Report found in cache (by slug, any author)", { slug: identifier });
                return cachedReport;
            }
        }

        // Cache miss - fall back to NDK fetch
        logger.debug("📰 Report not in cache, fetching from NDK", { identifier });

        let article: NDKArticle | null = null;

        // Check if identifier is an naddr
        if (identifier.startsWith("naddr1")) {
            // Decode the naddr to get the event
            const decoded = nip19.decode(identifier);
            if (decoded.type === "naddr" && decoded.data.kind === 30023) {
                // Fetch the specific article
                const filter = {
                    kinds: [30023],
                    authors: [decoded.data.pubkey],
                    "#d": [decoded.data.identifier],
                };

                const events = await this.ndk.fetchEvents(filter);
                if (events.size > 0) {
                    const event = Array.from(events)[0];
                    article = NDKArticle.from(event);
                }
            }
        } else if (agentPubkey) {
            // Treat as a slug - search for articles with this d-tag from specific agent
            const filter = {
                kinds: [30023],
                authors: [agentPubkey],
                "#d": [identifier],
            };

            const events = await this.ndk.fetchEvents(filter);
            if (events.size > 0) {
                const event = Array.from(events)[0];
                article = NDKArticle.from(event);
            }
        }

        if (!article) {
            return null;
        }

        const reportInfo = this.articleToReportInfo(article);

        // Add to cache for future lookups
        projectCtx.addReport(reportInfo);

        return reportInfo;
    }

    /**
     * List reports from project agents
     * Uses cached reports for fast lookup
     */
    async listReports(agentPubkeys?: string[]): Promise<ReportSummary[]> {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        // Get reports from cache
        let cachedReports = projectCtx.getAllReports();

        // Filter by agent pubkeys if provided
        if (agentPubkeys && agentPubkeys.length > 0) {
            const pubkeySet = new Set(agentPubkeys);
            cachedReports = cachedReports.filter((report) => {
                // Extract pubkey from author (could be npub or hex)
                const authorPubkey = this.extractPubkeyFromAuthor(report.author);
                return authorPubkey && pubkeySet.has(authorPubkey);
            });
        }

        // Filter out deleted reports and convert to ReportSummary
        const reports: ReportSummary[] = cachedReports
            .filter((report) => !report.isDeleted)
            .map((report) => ({
                id: report.id,
                slug: report.slug,
                title: report.title,
                summary: report.summary,
                author: report.author,
                publishedAt: report.publishedAt,
                hashtags: report.hashtags,
            }));

        // Sort reports by published date (newest first)
        reports.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

        logger.debug("📰 Listed reports from cache", {
            total: reports.length,
            cacheSize: projectCtx.reports.size,
        });

        return reports;
    }

    /**
     * Extract hex pubkey from author string (handles npub and hex formats)
     */
    private extractPubkeyFromAuthor(author: string): string | undefined {
        if (!author) return undefined;

        // If it's an npub, decode it
        if (author.startsWith("npub1")) {
            try {
                const decoded = nip19.decode(author);
                if (decoded.type === "npub") {
                    return decoded.data as string;
                }
            } catch {
                return undefined;
            }
        }

        // Assume it's already a hex pubkey
        return author;
    }

    /**
     * Delete a report by marking it as deleted
     */
    async deleteReport(slug: string, agent: ReportAuthor): Promise<string> {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        if (!agent.signer) {
            throw new Error("Agent signer required to delete reports");
        }

        // First, find the existing article
        const filter = {
            kinds: [30023],
            authors: [agent.pubkey],
            "#d": [slug],
        };

        const events = await this.ndk.fetchEvents(filter);
        if (events.size === 0) {
            throw new Error(`No report found with slug: ${slug}`);
        }

        const event = Array.from(events)[0];
        const article = NDKArticle.from(event);

        // Create a new version with empty content and deleted tag
        const deletedArticle = new NDKArticle(this.ndk);

        // Preserve the d-tag
        deletedArticle.dTag = slug;

        // Set minimal properties
        deletedArticle.title = article.title || "Deleted Report";
        deletedArticle.summary = "This report has been deleted";
        deletedArticle.content = "";
        deletedArticle.published_at = Math.floor(Date.now() / 1000);

        // Add the deleted tag
        deletedArticle.tags.push(["deleted"]);

        // Preserve the project tag
        const projectTagId = projectCtx.project.tagId();
        deletedArticle.tags.push(["a", projectTagId]);

        // Add author tag
        deletedArticle.tags.push(["p", agent.pubkey, "", "author"]);

        // Sign and publish the updated article
        await agent.sign(deletedArticle);
        await deletedArticle.publish();

        logger.info("🗑️ Report marked as deleted", {
            slug,
            articleId: deletedArticle.encode(),
        });

        return deletedArticle.encode();
    }

    /**
     * Get all agent pubkeys from the project context
     */
    getAllProjectAgentPubkeys(): string[] {
        const projectCtx = getProjectContext();
        if (!projectCtx) {
            return [];
        }

        const agentPubkeys: string[] = [];

        // Add project manager pubkey
        if (projectCtx.projectManager) {
            agentPubkeys.push(projectCtx.projectManager.pubkey);
        }

        // Add all other agents
        if (projectCtx.agents) {
            for (const agent of projectCtx.agents.values()) {
                if (!agentPubkeys.includes(agent.pubkey)) {
                    agentPubkeys.push(agent.pubkey);
                }
            }
        }

        return agentPubkeys;
    }

    /**
     * Convert an NDKArticle to ReportInfo
     */
    private articleToReportInfo(article: NDKArticle): ReportInfo {
        // Extract hashtags from tags (excluding the "memorize" tag)
        const hashtags = article.tags
            .filter((tag) => tag[0] === "t" && tag[1] !== "memorize")
            .map((tag) => tag[1]);

        // Extract project reference if present
        const projectTag = article.tags.find(
            (tag) => tag[0] === "a" && tag[1]?.includes(":31933:")
        );
        const projectReference = projectTag ? projectTag[1] : undefined;

        // Check if deleted
        const isDeleted = article.tags.some((tag) => tag[0] === "deleted");

        // Check if memorized
        const isMemorized = article.tags.some((tag) => tag[0] === "t" && tag[1] === "memorize");

        // Get author npub
        const authorNpub = article.author.npub;

        return {
            id: `nostr:${article.encode()}`,
            slug: article.dTag || "",
            title: article.title,
            summary: article.summary,
            content: article.content,
            author: authorNpub,
            publishedAt: article.published_at,
            hashtags: hashtags.length > 0 ? hashtags : undefined,
            projectReference,
            isDeleted,
            isMemorized,
        };
    }

    /**
     * Get memorized reports for a specific agent.
     * Returns reports that have the "memorize" tag.
     * Uses cached reports for instant lookup.
     */
    getMemorizedReports(agentPubkey: string): ReportInfo[] {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        // Get memorized reports for this agent from cache
        const reports = projectCtx.getMemorizedReportsForAgent(agentPubkey);

        // Filter out deleted reports (should already be excluded, but double-check)
        const activeReports = reports.filter((report) => !report.isDeleted);

        // Sort by published date (oldest first - so they appear in chronological order in the prompt)
        activeReports.sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0));

        logger.debug("📚 Retrieved memorized reports from cache", {
            agentPubkey: agentPubkey.substring(0, 16),
            count: activeReports.length,
            slugs: activeReports.map((r) => r.slug),
        });

        return activeReports;
    }

    /**
     * Get all memorized reports for any agent.
     * Useful for project-wide memorized knowledge.
     */
    getAllMemorizedReports(): ReportInfo[] {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        // Get all memorized reports from cache
        const reports = projectCtx.getMemorizedReports();

        // Filter out deleted reports
        const activeReports = reports.filter((report) => !report.isDeleted);

        // Sort by published date (oldest first)
        activeReports.sort((a, b) => (a.publishedAt || 0) - (b.publishedAt || 0));

        return activeReports;
    }

    /**
     * Get report cache statistics for monitoring
     */
    getCacheStats(): { total: number; memorized: number; byAuthor: Record<string, number> } {
        const projectCtx = getProjectContext();
        return projectCtx.getReportCacheStats();
    }
}
