import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutionContext } from '@/agents/execution/types';
import { logger } from '@/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

const uploadBlobSchema = z.object({
  input: z
      .string().describe("REQUIRED: The source to upload - can be a file path (e.g., /path/to/file.jpg), URL to download from (e.g., https://example.com/image.jpg), or base64-encoded blob data. This parameter must be named 'input', not 'url' or 'file'."),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type of the data (e.g., 'image/jpeg', 'video/mp4'). If not provided, it will be detected from the file extension, URL response headers, or data"),
  description: z
    .string()
    .optional()
    .describe("Optional description of the upload for the authorization event"),
});

type UploadBlobInput = z.infer<typeof uploadBlobSchema>;

interface UploadBlobOutput {
  url: string;
  sha256: string;
  size: number;
  type?: string;
  uploaded: number;
}

interface BlossomConfig {
  serverUrl?: string;
}

/**
 * Get Blossom server configuration from config file
 */
async function getBlossomConfig(): Promise<BlossomConfig> {
  try {
    const configPath = path.join(process.cwd(), '.tenex', 'config.json');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    return {
      serverUrl: config.blossomServerUrl || 'https://blossom.primal.net'
    };
  } catch (error) {
    // Return default configuration if file doesn't exist or has errors
    return {
      serverUrl: 'https://blossom.primal.net'
    };
  }
}

/**
 * Detect MIME type from file extension or data
 */
function detectMimeType(filePath?: string, data?: Buffer): string {
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
      '.json': 'application/json',
      '.txt': 'text/plain',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  // Try to detect from data magic bytes
  if (data && data.length > 4) {
    const header = data.slice(0, 4).toString('hex');
    if (header.startsWith('ffd8ff')) return 'image/jpeg';
    if (header === '89504e47') return 'image/png';
    if (header === '47494638') return 'image/gif';
    if (header.startsWith('52494646') && data.slice(8, 12).toString('hex') === '57454250') return 'image/webp';
  }

  return 'application/octet-stream';
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'text/plain': '.txt',
  };
  return extensions[mimeType] || '';
}

/**
 * Check if input is a URL
 */
function isURL(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Download media from URL
 */
async function downloadFromURL(url: string): Promise<{ data: Buffer; mimeType?: string; filename?: string }> {
  logger.info('[upload_blob] Downloading from URL', { url });
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TENEX/1.0 (Blossom Upload Tool)'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download from URL: ${response.status} ${response.statusText}`);
  }

  // Get content type from headers
  const contentType = response.headers.get('content-type');
  const mimeType = contentType?.split(';')[0].trim();
  
  // Try to extract filename from Content-Disposition header or URL
  let filename: string | undefined;
  const contentDisposition = response.headers.get('content-disposition');
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch) {
      filename = filenameMatch[1].replace(/['"]/g, '');
    }
  }
  
  if (!filename) {
    // Try to extract filename from URL
    const urlPath = new URL(url).pathname;
    const pathSegments = urlPath.split('/');
    const lastSegment = pathSegments[pathSegments.length - 1];
    if (lastSegment && lastSegment.includes('.')) {
      filename = lastSegment;
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  
  logger.info('[upload_blob] Downloaded from URL', {
    size: data.length,
    mimeType,
    filename
  });

  return { data, mimeType, filename };
}

/**
 * Calculate SHA256 hash of data
 */
function calculateSHA256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Create Blossom authorization event (kind 24242)
 */
async function createAuthEvent(
  sha256Hash: string,
  description: string,
  context: ExecutionContext
): Promise<any> {
  const { NDKEvent } = await import('@nostr-dev-kit/ndk');
  
  const event = new NDKEvent();
  event.kind = 24242;
  event.content = description;
  event.created_at = Math.floor(Date.now() / 1000);
  event.tags = [
    ['t', 'upload'],
    ['x', sha256Hash],
    ['expiration', String(Math.floor(Date.now() / 1000) + 3600)] // 1 hour expiration
  ];
  
  // Sign the event with the agent's signer
  await context.agent.sign(event);
  
  return event;
}

/**
 * Upload data to Blossom server
 */
async function uploadToBlossomServer(
  serverUrl: string,
  data: Buffer,
  mimeType: string,
  authEvent: any
): Promise<UploadBlobOutput> {
  // Encode the auth event as base64 for the header
  const authHeader = `Nostr ${Buffer.from(JSON.stringify(authEvent.rawEvent())).toString('base64')}`;
  
  const response = await fetch(`${serverUrl}/upload`, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': mimeType,
      'Content-Length': String(data.length),
    },
    body: data,
  });

  if (!response.ok) {
    let errorMessage = `Upload failed with status ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData.message) {
        errorMessage = `Upload failed: ${errorData.message}`;
      }
    } catch {
      // If parsing JSON fails, use the default error message
    }
    throw new Error(errorMessage);
  }

  const result = await response.json();
  
  // Add extension to URL if not present and we can determine it
  if (result.url && !path.extname(result.url)) {
    const ext = getExtensionFromMimeType(mimeType);
    if (ext) {
      result.url = result.url + ext;
    }
  }
  
  return result;
}

/**
 * Execute the upload_blob tool
 */
async function executeUploadBlob(
  input: UploadBlobInput,
  context: ExecutionContext
): Promise<UploadBlobOutput> {
  const { input: dataInput, mimeType: providedMimeType, description } = input;
  
  // Validate that input is provided
  if (!dataInput) {
    throw new Error("The 'input' parameter is required. Pass the URL, file path, or base64 data via { input: '...' }. Note: The parameter name is 'input', not 'url' or 'file'.");
  }
  
  logger.info('[upload_blob] Starting blob upload', {
    isURL: isURL(dataInput),
    hasFilePath: !isURL(dataInput) && !dataInput.startsWith('data:') && !dataInput.includes(','),
    hasMimeType: !!providedMimeType,
    description,
  });

  // Get Blossom server configuration
  const config = await getBlossomConfig();
  const serverUrl = config.serverUrl!;
  
  logger.info('[upload_blob] Using Blossom server', { serverUrl });

  let data: Buffer;
  let mimeType: string;
  let uploadDescription: string;

  // Check if input is a URL
  if (isURL(dataInput)) {
    // Handle URL download
    const downloadResult = await downloadFromURL(dataInput);
    data = downloadResult.data;
    mimeType = providedMimeType || downloadResult.mimeType || detectMimeType(downloadResult.filename, data);
    uploadDescription = description || downloadResult.filename || 'Upload from URL';
  } else if (dataInput.startsWith('data:') || dataInput.includes(',')) {
    // Handle base64 data (with or without data URL prefix)
    const base64Data = dataInput.includes(',') 
      ? dataInput.split(',')[1] 
      : dataInput;
    
    // Extract MIME type from data URL if present
    if (dataInput.startsWith('data:')) {
      const matches = dataInput.match(/^data:([^;]+);/);
      if (matches) {
        mimeType = matches[1];
      } else {
        mimeType = providedMimeType || 'application/octet-stream';
      }
    } else {
      mimeType = providedMimeType || 'application/octet-stream';
    }
    
    data = Buffer.from(base64Data, 'base64');
    uploadDescription = description || 'Upload blob data';
  } else {
    // Handle file path
    const filePath = path.resolve(dataInput);
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (error) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    data = await fs.readFile(filePath);
    mimeType = providedMimeType || detectMimeType(filePath, data);
    uploadDescription = description || `Upload ${path.basename(filePath)}`;
  }

  // Calculate SHA256 hash
  const sha256Hash = calculateSHA256(data);
  
  logger.info('[upload_blob] Calculated SHA256', {
    hash: sha256Hash,
    size: data.length,
    mimeType,
  });

  // Create authorization event
  const authEvent = await createAuthEvent(sha256Hash, uploadDescription, context);
  
  logger.info('[upload_blob] Created authorization event', {
    eventId: authEvent.id,
    kind: authEvent.kind,
  });

  try {
    // Upload to Blossom server
    const result = await uploadToBlossomServer(serverUrl, data, mimeType, authEvent);
    
    logger.info('[upload_blob] Upload successful', {
      url: result.url,
      sha256: result.sha256,
      size: result.size,
    });
    
    return result;
  } catch (error) {
    logger.error('[upload_blob] Upload failed', { error });
    throw error;
  }
}

/**
 * Create the upload_blob tool for AI SDK
 */
export function createUploadBlobTool(context: ExecutionContext) {
  const aiTool = tool({
    description: `Upload files, URLs, or base64 blobs to a Blossom server.

    IMPORTANT: The parameter is named 'input' (not 'url' or 'file').

    Pass the source via the 'input' parameter:
    - URLs: { input: "https://example.com/image.jpg" }
    - File paths: { input: "/path/to/file.jpg" }
    - Base64 data: { input: "data:image/jpeg;base64,..." } or { input: "<base64_string>" }

    Optional parameters:
    - mimeType: Specify MIME type (auto-detected if not provided)
    - description: Add a description for the upload

    The Blossom server URL is configured in .tenex/config.json (default: https://blossom.primal.net).
    Returns the URL of the uploaded media with appropriate file extension.`,
    inputSchema: uploadBlobSchema,
    execute: async (input: UploadBlobInput) => {
      return await executeUploadBlob(input, context);
    },
  });

  // Add human-readable content generation
  Object.defineProperty(aiTool, 'getHumanReadableContent', {
    value: (args: UploadBlobInput | undefined) => {
      if (!args || !args.input) {
        return 'Uploading blob data';
      }
      const { input, description } = args;
      
      if (isURL(input)) {
        const url = new URL(input);
        return `Downloading and uploading from ${url.hostname}${description ? ` - ${description}` : ''}`;
      } else if (!input.startsWith('data:') && !input.includes(',')) {
        return `Uploading file: ${path.basename(input)}${description ? ` - ${description}` : ''}`;
      } else {
        return `Uploading blob data${description ? ` - ${description}` : ''}`;
      }
    },
    enumerable: false,
    configurable: true,
  });

  return aiTool;
}

/**
 * upload_blob tool - Upload files, URLs, or base64 blobs to a Blossom server
 * 
 * This tool enables agents to upload media to a Blossom server from various sources,
 * following the Blossom protocol specification for decentralized media storage.
 * 
 * Features:
 * - Downloads and uploads media from URLs (http/https)
 * - Supports file uploads from the filesystem
 * - Supports base64-encoded blob uploads
 * - Automatic MIME type detection from file extensions, URL headers, or data
 * - Proper file extension handling in returned URLs
 * - Configurable Blossom server URL via .tenex/config.json
 * - Nostr event-based authentication (kind 24242)
 * 
 * The tool handles the complete Blossom upload workflow:
 * 1. Downloads from URL, reads file, or decodes base64 data
 * 2. Calculates SHA256 hash
 * 3. Creates and signs authorization event
 * 4. Uploads to Blossom server with proper headers
 * 5. Returns the media URL with appropriate extension
 * 
 * Configuration:
 * Add "blossomServerUrl" to .tenex/config.json to customize the server
 * Default server: https://blossom.primal.net
 */