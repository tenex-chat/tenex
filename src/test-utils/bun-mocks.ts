import { mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Create a mock NDKEvent for testing
 */
export function createMockNDKEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
  const event = {
    id: "test-event-id",
    kind: 1,
    pubkey: "test-pubkey",
    created_at: Math.floor(Date.now() / 1000),
    content: "test content",
    tags: [],
    sig: "test-sig",
    relay: undefined,
    tag: mock((tag: string[]) => {
      (event as any).tags.push(tag);
    }),
    tagValue: mock((tagName: string) => {
      const tag = (event as any).tags.find((t: string[]) => t[0] === tagName);
      return tag ? tag[1] : undefined;
    }),
    getMatchingTags: mock((tagName: string) => {
      return (event as any).tags.filter((t: string[]) => t[0] === tagName);
    }),
    tagReference: mock(() => ["e", "test-event-id"]),
    publish: mock(() => Promise.resolve()),
    reply: mock(() => {
      const replyEvent = createMockNDKEvent();
      replyEvent.tags = [["e", "test-event-id", "", "reply"]];
      return replyEvent;
    }),
    ...overrides,
  };
  
  // Override tags if provided
  if (overrides.tags) {
    event.tags = overrides.tags;
  }
  
  return event as unknown as NDKEvent;
}

/**
 * Create a mock NDK instance
 */
export function createMockNDK(overrides: any = {}) {
  return {
    fetchEvent: mock(() => Promise.resolve(null)),
    fetchEvents: mock(() => Promise.resolve(new Set())),
    publish: mock(() => Promise.resolve()),
    connect: mock(() => Promise.resolve()),
    signer: {
      sign: mock(() => Promise.resolve("signature")),
      pubkey: mock(() => "test-pubkey"),
    },
    ...overrides,
  };
}

/**
 * Create a mock Conversation
 */
export function createMockConversation(overrides: any = {}) {
  return {
    id: "test-conversation-id",
    title: "Test Conversation",
    phase: "CHAT",
    history: [],
    agentStates: new Map(),
    metadata: {},
    phaseTransitions: [],
    executionTime: {
      totalSeconds: 0,
      isActive: false,
      lastUpdated: Date.now(),
    },
    ...overrides,
  };
}

/**
 * Create a mock Agent
 */
export function createMockAgent(overrides: any = {}) {
  return {
    name: "test-agent",
    slug: "test-agent",
    pubkey: "test-agent-pubkey",
    role: "Test role",
    backend: "reason-act-loop",
    tools: [],
    ...overrides,
  };
}

/**
 * Create mock file system operations
 */
export function createMockFS() {
  const files = new Map<string, string>();
  const directories = new Set<string>(["/", "/tmp"]);

  return {
    readFile: mock((path: string) => {
      if (!files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return Promise.resolve(files.get(path)!);
    }),
    writeFile: mock((path: string, content: string) => {
      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir && !directories.has(dir)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      files.set(path, content);
      return Promise.resolve();
    }),
    mkdir: mock((path: string, options?: any) => {
      directories.add(path);
      // Add parent directories if recursive
      if (options?.recursive) {
        let currentPath = "";
        for (const part of path.split("/").filter(Boolean)) {
          currentPath += "/" + part;
          directories.add(currentPath);
        }
      }
      return Promise.resolve();
    }),
    readdir: mock((path: string) => {
      if (!directories.has(path)) {
        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      }
      const entries: string[] = [];
      const prefix = path.endsWith("/") ? path : path + "/";
      
      // Find files in this directory
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const relative = filePath.substring(prefix.length);
          if (!relative.includes("/")) {
            entries.push(relative);
          }
        }
      }
      
      // Find subdirectories
      for (const dir of directories) {
        if (dir.startsWith(prefix) && dir !== path) {
          const relative = dir.substring(prefix.length);
          const firstPart = relative.split("/")[0];
          if (firstPart && !entries.includes(firstPart)) {
            entries.push(firstPart);
          }
        }
      }
      
      return Promise.resolve(entries);
    }),
    stat: mock((path: string) => {
      if (files.has(path)) {
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: files.get(path)!.length,
        });
      }
      if (directories.has(path)) {
        return Promise.resolve({
          isFile: () => false,
          isDirectory: () => true,
          size: 0,
        });
      }
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }),
    unlink: mock((path: string) => {
      if (!files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      }
      files.delete(path);
      return Promise.resolve();
    }),
    // Helper methods for testing
    _setFile: (path: string, content: string) => {
      files.set(path, content);
    },
    _setDirectory: (path: string) => {
      directories.add(path);
    },
    _clear: () => {
      files.clear();
      directories.clear();
      directories.add("/");
      directories.add("/tmp");
    },
    _getFiles: () => files,
    _getDirectories: () => directories,
  };
}