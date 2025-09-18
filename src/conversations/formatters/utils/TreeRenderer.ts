export class TreeRenderer {
  /**
   * Get the connector character(s) for the current node
   */
  getConnector(style: 'ascii' | 'unicode' | 'markdown', isLast: boolean): string {
    switch (style) {
      case 'ascii':
        return isLast ? '└── ' : '├── ';
      case 'unicode':
        return isLast ? '└── ' : '├── ';
      case 'markdown':
        return '- ';
      default:
        return '';
    }
  }
  
  /**
   * Get the prefix for child nodes
   */
  getChildPrefix(style: 'ascii' | 'unicode' | 'markdown', parentIsLast: boolean): string {
    switch (style) {
      case 'ascii':
        return parentIsLast ? '    ' : '│   ';
      case 'unicode':
        return parentIsLast ? '    ' : '│   ';
      case 'markdown':
        return '  ';
      default:
        return '';
    }
  }
  
  /**
   * Get a separator line between threads
   */
  getSeparator(style: 'ascii' | 'unicode' | 'markdown', width: number = 60): string {
    switch (style) {
      case 'ascii':
        return '-'.repeat(width);
      case 'unicode':
        return '─'.repeat(width);
      case 'markdown':
        return '\n---\n';
      default:
        return '';
    }
  }
}