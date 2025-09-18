import { NDKEvent } from '@nostr-dev-kit/ndk';
import { ThreadNode } from '../ThreadedConversationFormatter';

export class TreeBuilder {
  /**
   * Build tree structure from flat event list
   */
  buildFromEvents(events: NDKEvent[]): ThreadNode[] {
    if (events.length === 0) {
      return [];
    }
    
    // Create node map indexed by event ID
    const nodeMap = new Map<string, ThreadNode>();
    const rootNodes: ThreadNode[] = [];
    
    // First pass: create all nodes
    for (const event of events) {
      const node: ThreadNode = {
        event,
        agent: this.extractAgentName(event),
        timestamp: new Date(event.created_at! * 1000),
        content: event.content,
        toolCall: this.extractToolCall(event),
        children: [],
        depth: 0
      };
      nodeMap.set(event.id, node);
    }
    
    // Second pass: establish parent-child relationships
    for (const event of events) {
      const node = nodeMap.get(event.id)!;
      const parentId = this.findParentEventId(event);
      
      if (parentId && nodeMap.has(parentId)) {
        const parentNode = nodeMap.get(parentId)!;
        parentNode.children.push(node);
      } else {
        // No parent found, this is a root node
        rootNodes.push(node);
      }
    }
    
    // Third pass: calculate depths and sort children
    for (const root of rootNodes) {
      this.calculateDepthsAndSort(root, 0);
    }
    
    // Sort root nodes by timestamp
    rootNodes.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    return rootNodes;
  }
  
  private findParentEventId(event: NDKEvent): string | null {
    // Look for 'e' tags that indicate a reply
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    
    // The convention is that the first 'e' tag is the root,
    // and the last 'e' tag is the direct parent (if multiple e tags)
    if (eTags.length === 1) {
      return eTags[0][1]; // Single e tag is the parent
    } else if (eTags.length > 1) {
      // Check for 'reply' marker
      const replyTag = eTags.find(tag => tag[3] === 'reply');
      if (replyTag) {
        return replyTag[1];
      }
      // Otherwise, last e tag is typically the direct parent
      return eTags[eTags.length - 1][1];
    }
    
    return null;
  }
  
  private extractAgentName(event: NDKEvent): string | undefined {
    // Look for agent identifier in tags
    const agentTag = event.tags.find(tag => tag[0] === 'agent');
    if (agentTag && agentTag[1]) {
      return agentTag[1];
    }
    
    // Try to extract from p tags with agent marker
    const pTags = event.tags.filter(tag => tag[0] === 'p');
    for (const pTag of pTags) {
      if (pTag[3] && pTag[3].startsWith('agent:')) {
        return pTag[3].substring(6);
      }
    }
    
    // Fallback: check if content suggests an agent
    if (event.content.startsWith('[') && event.content.includes(']:')) {
      const match = event.content.match(/^\[([^\]]+)\]:/); 
      if (match) {
        return match[1];
      }
    }
    
    return undefined;
  }
  
  private extractToolCall(event: NDKEvent): { name: string; args?: string } | undefined {
    // Look for tool call indicators in tags
    const toolTag = event.tags.find(tag => tag[0] === 'tool');
    if (toolTag) {
      return {
        name: toolTag[1],
        args: toolTag[2]
      };
    }
    
    // Check if content indicates a tool call - multiple patterns
    const patterns = [
      /(?:calls tool|using tool|executing):\s*(\w+)(?:\(([^)]*)\))?/i,
      /(?:calling tool|call):\s*(\w+)(?:\(([^)]*)\))?/i,
      /(?:Now|now)\s+calling\s+tool:\s*(\w+)(?:\(([^)]*)\))?/i
    ];
    
    for (const pattern of patterns) {
      const match = event.content.match(pattern);
      if (match) {
        return {
          name: match[1],
          args: match[2]
        };
      }
    }
    
    return undefined;
  }
  
  private calculateDepthsAndSort(node: ThreadNode, depth: number): void {
    node.depth = depth;
    
    // Sort children by timestamp
    node.children.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    
    // Recursively process children
    for (const child of node.children) {
      this.calculateDepthsAndSort(child, depth + 1);
    }
  }
}