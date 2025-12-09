import type { AgentInstance } from "@/agents/types";
import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import type NDK from "@nostr-dev-kit/ndk";
import { type NDKFilter, NDKArticle } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

export interface ReportData {
    slug: string;
    title: string;
    summary: string;
    content: string;
    hashtags?: string[];
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
    async writeReport(data: ReportData, agent: AgentInstance): Promise<string> {
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
     */
    async readReport(identifier: string, agentPubkey?: string): Promise<ReportInfo | null> {
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

        return this.articleToReportInfo(article);
    }

    /**
     * List reports from project agents
     */
    async listReports(agentPubkeys?: string[]): Promise<ReportSummary[]> {
        const projectCtx = getProjectContext();
        if (!projectCtx?.project) {
            throw new Error("No project context available");
        }

        // Get the project's tag ID to filter articles
        const projectTagId = projectCtx.project.tagId();

        // Build the filter for fetching articles
        interface ArticleFilter {
            kinds: number[];
            "#a": string[];
            authors?: string[];
        }

        const filter: ArticleFilter = {
            kinds: [30023],
            "#a": [projectTagId], // Articles that tag this project
        };

        // If agent pubkeys provided, filter by them
        if (agentPubkeys && agentPubkeys.length > 0) {
            filter.authors = agentPubkeys;
        }

        // Fetch the articles
        const events = await this.ndk.fetchEvents(filter as unknown as NDKFilter);

        // Process the articles
        const reports: ReportSummary[] = [];

        for (const event of events) {
            const article = NDKArticle.from(event);

            // Check if article is deleted
            const isDeleted = article.tags.some((tag) => tag[0] === "deleted");
            if (isDeleted) {
                continue; // Skip deleted articles
            }

            // Extract hashtags
            const hashtags = article.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);

            // Get author npub
            const authorNpub = article.author.npub;

            reports.push({
                id: `nostr:${article.encode()}`,
                slug: article.dTag || "",
                title: article.title,
                summary: article.summary,
                author: authorNpub,
                publishedAt: article.published_at,
                hashtags: hashtags.length > 0 ? hashtags : undefined,
            });
        }

        // Sort reports by published date (newest first)
        reports.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

        return reports;
    }

    /**
     * Delete a report by marking it as deleted
     */
    async deleteReport(slug: string, agent: AgentInstance): Promise<string> {
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
        // Extract hashtags from tags
        const hashtags = article.tags.filter((tag) => tag[0] === "t").map((tag) => tag[1]);

        // Extract project reference if present
        const projectTag = article.tags.find(
            (tag) => tag[0] === "a" && tag[1]?.includes(":31933:")
        );
        const projectReference = projectTag ? projectTag[1] : undefined;

        // Check if deleted
        const isDeleted = article.tags.some((tag) => tag[0] === "deleted");

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
        };
    }
}
