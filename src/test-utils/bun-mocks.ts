import { mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { Conversation, AgentState } from "@/conversations/types";
import type { AgentInstance } from "@/agents/types";

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
    tag: mock((tag: string[]): void => {
      (event as NDKEvent).tags.push(tag);
    }),
    tagValue: mock((tagName: string): string | undefined => {
      const tag = (event as NDKEvent).tags.find((t: string[]) => t[0] === tagName);
      return tag ? tag[1] : undefined;
    }),
    getMatchingTags: mock((tagName: string): string[][] => {
      return (event as NDKEvent).tags.filter((t: string[]) => t[0] === tagName);
    }),
    tagReference: mock((): string[] => ["e", "test-event-id"]),
    publish: mock((): Promise<void> => Promise.resolve()),
    reply: mock((): NDKEvent => {
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

interface MockNDK {
  fetchEvent: ReturnType<typeof mock>;
  fetchEvents: ReturnType<typeof mock>;
  publish: ReturnType<typeof mock>;
  connect: ReturnType<typeof mock>;
  signer: {
    sign: ReturnType<typeof mock>;
    pubkey: ReturnType<typeof mock>;
  };
  [key: string]: unknown;
}

/**
 * Create a mock NDK instance
 */
export function createMockNDK(overrides: Partial<MockNDK> = {}): MockNDK {
  return {
    fetchEvent: mock((): Promise<NDKEvent | null> => Promise.resolve(null)),
    fetchEvents: mock((): Promise<Set<NDKEvent>> => Promise.resolve(new Set())),
    publish: mock((): Promise<void> => Promise.resolve()),
    connect: mock((): Promise<void> => Promise.resolve()),
    signer: {
      sign: mock((): Promise<string> => Promise.resolve("signature")),
      pubkey: mock((): string => "test-pubkey"),
    },
    ...overrides,
  };
}

/**
 * Create a mock Conversation
 */
export function createMockConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "test-conversation-id",
    title: "Test Conversation",
    phase: "CHAT",
    history: [],
    agentStates: new Map<string, AgentState>(),
    metadata: {},
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
export function createMockAgent(overrides: Partial<AgentInstance> = {}): Partial<AgentInstance> {
  return {
    name: "test-agent",
    slug: "test-agent",
    pubkey: "test-agent-pubkey",
    role: "Test role",
    tools: [],
    ...overrides,
  };
}

interface MockFSOptions {
  recursive?: boolean;
  [key: string]: unknown;
}

interface MockFSStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}

interface MockFS {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: MockFSOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<MockFSStats>;
  unlink(path: string): Promise<void>;
  _setFile(path: string, content: string): void;
  _setDirectory(path: string): void;
  _clear(): void;
  _getFiles(): Map<string, string>;
  _getDirectories(): Set<string>;
}

/**
 * Create mock file system operations
 */
export function createMockFS(): MockFS {
  const files = new Map<string, string>();
  const directories = new Set<string>(["/", "/tmp"]);

  return {
    readFile: mock((path: string): Promise<string> => {
      if (!files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`File content is undefined for path: ${path}`);
      }
      return Promise.resolve(content);
    }),
    writeFile: mock((path: string, content: string): Promise<void> => {
      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir && !directories.has(dir)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      files.set(path, content);
      return Promise.resolve();
    }),
    mkdir: mock((path: string, options?: MockFSOptions): Promise<void> => {
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
    readdir: mock((path: string): Promise<string[]> => {
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
    stat: mock((path: string): Promise<MockFSStats> => {
      if (files.has(path)) {
        return Promise.resolve({
          isFile: () => true,
          isDirectory: () => false,
          size: files.get(path)?.length ?? 0,
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
    unlink: mock((path: string): Promise<void> => {
      if (!files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      }
      files.delete(path);
      return Promise.resolve();
    }),
    // Helper methods for testing
    _setFile: (path: string, content: string): void => {
      files.set(path, content);
    },
    _setDirectory: (path: string): void => {
      directories.add(path);
    },
    _clear: (): void => {
      files.clear();
      directories.clear();
      directories.add("/");
      directories.add("/tmp");
    },
    _getFiles: (): Map<string, string> => files,
    _getDirectories: (): Set<string> => directories,
  };
}