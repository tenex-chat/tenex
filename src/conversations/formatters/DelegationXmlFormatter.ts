import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface DelegationResponse {
    from: string;
    content: string;
    eventId: string;
    status: "completed" | "error";
}

interface DelegationInfo {
    id: string;
    from: string;
    recipients: string[];
    phase?: string;
    message: string;
    requestEventId: string;
    responses: DelegationResponse[];
}

/**
 * Formats delegation information as structured XML for LLM comprehension
 */
export class DelegationXmlFormatter {
    /**
     * Render a delegation with its responses as XML
     */
    static render(delegation: DelegationInfo, debug = false): string {
        const eventPrefix = debug ? `[Event ${delegation.requestEventId.substring(0, 8)}] ` : '';
        const recipientsAttr = delegation.recipients.join(',');
        const phaseAttr = delegation.phase ? ` phase="${delegation.phase}"` : '';

        let xml = `${eventPrefix}<delegation from="${delegation.from}" recipients="${recipientsAttr}" id="${delegation.id}"${phaseAttr}>`;
        xml += `\n    <delegation-request>${this.escapeXml(delegation.message)}</delegation-request>`;

        // Add responses
        for (const response of delegation.responses) {
            const statusAttr = response.status === "error" ? ' error="true"' : '';
            const eventIdAttr = debug ? ` event-id="${response.eventId.substring(0, 8)}"` : '';
            xml += `\n    <response from="${response.from}"${statusAttr}${eventIdAttr}>${this.escapeXml(response.content)}</response>`;
        }

        // Add pending placeholders for recipients without responses
        const respondedFrom = new Set(delegation.responses.map(r => r.from));
        for (const recipient of delegation.recipients) {
            if (!respondedFrom.has(recipient)) {
                xml += `\n    <response from="${recipient}" status="pending" />`;
            }
        }

        xml += `\n</delegation>`;

        return xml;
    }

    /**
     * Escape XML special characters
     */
    private static escapeXml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
}
