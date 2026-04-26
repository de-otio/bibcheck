/**
 * Markdown renderer for bibcheck output.
 *
 * Produces a sectioned human-readable report with tables for entry-level
 * findings and lists for linkage failures, phrase flags, and worklist items.
 * All sections are always present; empty sections show "No findings." rather
 * than being omitted, so the document structure is stable across runs.
 */

import type { Output, Entry, LinkageEntry, PhraseFlag, WorklistItem } from '../schema/output.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape pipe characters so they don't break Markdown table cells. */
function escCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Format a file:line pair as a Markdown link for IDE/GitHub clickability. */
function fileLink(file: string, line: number): string {
  return `[${file}:${line}](${file}#L${line})`;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function renderSummaryTable(output: Output): string {
  const { summary, tool } = output;
  const lines: string[] = [
    '## Summary',
    '',
    `**Schema version:** ${output.schemaVersion}`,
    `**Tool:** ${tool.name}@${tool.version}`,
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Total entries | ${summary.totalEntries} |`,
    `| Verified | ${summary.verified} |`,
    `| Metadata mismatches | ${summary.metadataMismatches} |`,
    `| Unverifiable | ${summary.unverifiable} |`,
    `| Canonical issues | ${summary.canonicalIssues} |`,
    `| Linkage failures | ${summary.linkageFailures} |`,
    `| Phrase flags | ${summary.phraseFlags} |`,
    `| Worklist items | ${summary.worklistItems} |`,
    '',
  ];
  return lines.join('\n');
}

function renderEntriesTable(entries: Entry[]): string {
  const lines: string[] = ['## Bibliography entries', ''];
  if (entries.length === 0) {
    lines.push('No findings.');
    lines.push('');
    return lines.join('\n');
  }

  // Sort alphabetically by citekey.
  const sorted = [...entries].sort((a, b) => a.citekey.localeCompare(b.citekey));

  lines.push('| Citekey | Existence status | Canonical status | Canonical URL |');
  lines.push('|---------|-----------------|-----------------|---------------|');

  for (const entry of sorted) {
    const existStatus = entry.existence?.status ?? 'not run';
    const canonStatus = entry.canonical?.status ?? 'not run';
    const canonUrl = entry.canonical?.url != null ? `[link](${entry.canonical.url})` : '—';
    lines.push(
      `| ${escCell(entry.citekey)} | ${escCell(existStatus)} | ${escCell(canonStatus)} | ${canonUrl} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderLinkageSection(linkage: LinkageEntry[]): string {
  const lines: string[] = ['## Linkage', ''];
  const unresolved = [...linkage]
    .filter((l) => l.status === 'unresolved')
    .sort((a, b) => a.citekey.localeCompare(b.citekey));

  if (unresolved.length === 0) {
    lines.push('No findings.');
    lines.push('');
    return lines.join('\n');
  }

  for (const entry of unresolved) {
    lines.push(`- **@${entry.citekey}** — referenced in:`);
    const sortedRefs = [...entry.references].sort((a, b) => {
      const fc = a.file.localeCompare(b.file);
      return fc !== 0 ? fc : a.line - b.line;
    });
    for (const ref of sortedRefs) {
      lines.push(`  - ${fileLink(ref.file, ref.line)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderPhraseFlagsSection(phraseFlags: PhraseFlag[]): string {
  const lines: string[] = ['## Phrase flags', ''];
  const flagged = [...phraseFlags]
    .filter((f) => f.status === 'flagged')
    .sort((a, b) => {
      const fc = a.file.localeCompare(b.file);
      if (fc !== 0) return fc;
      if (a.line !== b.line) return a.line - b.line;
      return a.patternKey.localeCompare(b.patternKey);
    });

  if (flagged.length === 0) {
    lines.push('No findings.');
    lines.push('');
    return lines.join('\n');
  }

  for (const flag of flagged) {
    const loc = fileLink(flag.file, flag.line);
    lines.push(`- \`${flag.patternKey}\` in ${loc}: "${escCell(flag.matchedText)}"`);
    if (flag.referenceUrl != null) {
      lines.push(`  - Reference: <${flag.referenceUrl}>`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderWorklistSection(worklist: WorklistItem[]): string {
  const lines: string[] = ['## Worklist', ''];
  if (worklist.length === 0) {
    lines.push('No findings.');
    lines.push('');
    return lines.join('\n');
  }

  const sorted = [...worklist].sort((a, b) => {
    const fc = a.file.localeCompare(b.file);
    if (fc !== 0) return fc;
    if (a.line !== b.line) return a.line - b.line;
    return a.type.localeCompare(b.type);
  });

  for (const item of sorted) {
    const loc = fileLink(item.file, item.line);
    const verif =
      item.verificationUrl != null ? `<${item.verificationUrl}>` : 'manual';
    lines.push(`- [${item.type}] ${loc} — ${escCell(item.recommendedAction)}`);
    lines.push(`  - Citation: \`${item.citation}\``);
    lines.push(`  - Verification: ${verif}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a validated Output as a Markdown string.
 *
 * The document always contains all sections, even when empty, so its structure
 * is stable and predictable for downstream consumers. Sections with no findings
 * show "No findings." rather than being omitted.
 *
 * Lists are sorted deterministically (alpha by citekey or file:line) so two
 * renders of the same input produce byte-identical output.
 */
export function renderMarkdown(output: Output): string {
  const sections: string[] = [
    '# bibcheck report',
    '',
    renderSummaryTable(output),
    renderEntriesTable(output.entries),
    renderLinkageSection(output.linkage),
    renderPhraseFlagsSection(output.phraseFlags),
    renderWorklistSection(output.worklist),
  ];
  return sections.join('\n');
}
