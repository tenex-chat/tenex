# Codebase Search Tool

## Overview

The `codebase_search` tool provides powerful search capabilities for exploring project codebases. It supports searching by file names, content within files, or both, with various filtering and display options.

## Features

- **File name search**: Find files and directories by name patterns
- **Content search**: Search for text within file contents using grep
- **Combined search**: Search both file names and contents simultaneously  
- **File type filtering**: Limit searches to specific file extensions
- **Result limiting**: Control the maximum number of results returned
- **Content snippets**: Optionally include relevant code snippets in results
- **Safe sandboxing**: All searches are restricted to the project directory

## Tool Specification

```json
{
  "name": "codebase_search",
  "description": "Searches the project codebase for files, directories, or content matching specified criteria. Supports searching by file name patterns, content keywords, or file types. Returns a list of matching paths with optional snippets. Paths are relative to project root. Safe and sandboxed to project directory.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query - can be file name (e.g., 'ChatHeader.tsx'), pattern (e.g., '*.tsx'), or content to grep (e.g., 'function ChatHeader')"
      },
      "searchType": {
        "type": "string",
        "enum": ["filename", "content", "both"],
        "default": "both",
        "description": "Type of search: 'filename' for name matching, 'content' for text inside files, 'both' for combined"
      },
      "fileType": {
        "type": ["string", "null"],
        "description": "Optional file extension filter (e.g., '.tsx')"
      },
      "maxResults": {
        "type": ["integer", "null"],
        "default": 50,
        "description": "Maximum number of results to return"
      },
      "includeSnippets": {
        "type": ["boolean", "null"],
        "default": false,
        "description": "If true, include brief content snippets for content matches"
      }
    },
    "required": ["query"]
  }
}
```

## Usage Examples

### Search for files by name
```typescript
const result = await tool.execute({
  query: "ChatHeader",
  searchType: "filename"
});
```

### Search for content within TypeScript files
```typescript
const result = await tool.execute({
  query: "useState",
  searchType: "content",
  fileType: ".tsx",
  includeSnippets: true
});
```

### Combined search with result limit
```typescript
const result = await tool.execute({
  query: "authentication",
  searchType: "both",
  maxResults: 10
});
```

## Implementation Details

The tool uses efficient system commands for searching:

- **File search**: Uses `find` command with pattern matching
- **Content search**: Uses `grep` with line numbers and context
- **Fallback**: Implements recursive directory traversal if system commands fail
- **Exclusions**: Automatically excludes common directories (node_modules, .git, dist, build, .next, coverage)

## Output Format

The tool returns a formatted string with:
- Summary of results found
- List of matching paths (relative to project root)
- File type indicators (file or directory)
- Optional line numbers for content matches
- Optional content snippets when requested

Example output:
```
Found 3 results for "useState":

• components/Header.tsx [line 5]
  const [isOpen, setIsOpen] = useState(false);
• hooks/useAuth.ts [line 12]
  const [user, setUser] = useState(null);
• pages/index.tsx [line 8]
  const [loading, setLoading] = useState(true);
```

## Integration

The tool is registered in the system's tool registry and can be accessed by agents using:

```typescript
import { createCodebaseSearchTool } from "./implementations/codebase_search";

// In the registry
codebase_search: createCodebaseSearchTool
```

## Testing

The tool includes comprehensive test coverage:
- Unit tests for search functionality
- Integration tests against real filesystem
- Parameter validation tests
- Error handling tests

Run tests with:
```bash
npm test -- src/tools/implementations/__tests__/codebase_search
```