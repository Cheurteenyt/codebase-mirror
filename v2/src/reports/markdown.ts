/**
 * Escape an arbitrary value for a GitHub-Flavored Markdown table cell.
 *
 * Backslashes must be escaped before pipes; otherwise an input such as `\|`
 * can neutralize the backslash added for the pipe. Line breaks are flattened
 * so one value cannot inject additional table rows.
 */
export function escapeMarkdownTableCell(value: unknown): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, ' ');
}
