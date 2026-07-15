import { describe, expect, it } from 'vitest';
import { escapeMarkdownTableCell } from '../../src/reports/markdown.js';

describe('escapeMarkdownTableCell', () => {
  it('escapes pipes', () => {
    expect(escapeMarkdownTableCell('alpha|beta|gamma')).toBe(
      String.raw`alpha\|beta\|gamma`,
    );
  });

  it('escapes an existing backslash before escaping a pipe', () => {
    expect(escapeMarkdownTableCell(String.raw`alpha\|beta`)).toBe(
      String.raw`alpha\\\|beta`,
    );
  });

  it('flattens line breaks so values cannot add table rows', () => {
    expect(escapeMarkdownTableCell('first\r\n| second |\nthird')).toBe(
      String.raw`first \| second \| third`,
    );
  });

  it('escapes a trailing backslash', () => {
    expect(escapeMarkdownTableCell('path\\')).toBe('path\\\\');
  });
});
