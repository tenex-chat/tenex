
## Tool: codebase_search

### Description

Searches the project codebase for files, directories, or content matching specified criteria. Supports searching by file name patterns, content keywords, or file types. Returns a list of matching paths with optional snippets. Paths are relative to project root. Safe and sandboxed to project directory.

### JSON Schema

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
        "enum": [
          "filename",
          "content",
          "both"
        ],
        "default": "both",
        "description": "Type of search: 'filename' for name matching, 'content' for text inside files, 'both' for combined"
      },
      "fileType": {
        "type": [
          "string",
          "null"
        ],
        "description": "Optional file extension filter (e.g., '.tsx')"
      },
      "maxResults": {
        "type": [
          "integer",
          "null"
        ],
        "default": 50,
        "description": "Maximum number of results to return"
      },
      "includeSnippets": {
        "type": [
          "boolean",
          "null"
        ],
        "default": false,
        "description": "If true, include brief content snippets for content matches"
      }
    },
    "required": [
      "query"
    ],
    "additionalProperties": false
  },
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```
