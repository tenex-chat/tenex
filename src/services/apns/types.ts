/**
 * APNs push notification types.
 *
 * Covers device token registration (via kind 25000 events),
 * Apple APNs payload format, and HTTP/2 client response handling.
 */

// =====================================================================================
// CONFIG UPDATE EVENT (kind 25000) — decrypted content
// =====================================================================================

/**
 * Decrypted content of a kind 25000 config update event.
 * The iOS client publishes this encrypted (NIP-44) to the backend's pubkey.
 */
export interface ConfigUpdateContent {
    notifications?: {
        enable: boolean;
        apn_token: string;
    };
}

// =====================================================================================
// APNs PAYLOAD — sent to Apple
// =====================================================================================

/**
 * APNs alert payload structure.
 */
export interface APNsAlert {
    title: string;
    body: string;
}

/**
 * The `aps` dictionary inside an APNs payload.
 */
export interface APNsAps {
    alert: APNsAlert;
    sound: string;
    badge?: number;
}

/**
 * Full APNs payload sent to Apple's HTTP/2 API.
 */
export interface APNsPayload {
    aps: APNsAps;
    conversationId?: string;
    eventId?: string;
}

// =====================================================================================
// NOTIFICATION REQUEST — internal interface
// =====================================================================================

/**
 * Data passed from the ask tool to APNsService.notifyIfNeeded().
 */
export interface NotificationRequest {
    title: string;
    body: string;
    conversationId: string;
    eventId: string;
}

// =====================================================================================
// APNs CLIENT RESPONSE
// =====================================================================================

/**
 * Result from sending a push notification via APNsClient.
 */
export interface APNsSendResult {
    success: boolean;
    statusCode: number;
    reason?: string;
    /** Apple-provided timestamp when the token became invalid (for 410 Gone). */
    timestampMs?: number;
}
