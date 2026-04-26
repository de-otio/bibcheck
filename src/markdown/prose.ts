/**
 * Shared helper: extract prose lines from markdown content.
 *
 * Parses the content via remark/unified to an mdast AST and walks the tree,
 * skipping nodes whose content should not be treated as prose (code blocks,
 * inline code, raw HTML, YAML/TOML front-matter). Returns one ProseLine per
 * source line that contains prose, sorted and deduplicated by line number.
 *
 * YAML/TOML front-matter is stripped before AST parsing because remark-parse
 * alone does not emit yaml/toml AST nodes — the remark-frontmatter plugin is
 * required for that. Instead, we detect the standard --- / +++ delimiters
 * manually and record which lines to exclude from the result.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Node, Parent } from 'mdast';

export type ProseLine = {
  line: number; // 1-based line number in the original source
  text: string; // the text of that line (slice of original content)
};

const SKIP_TYPES = new Set(['code', 'inlineCode', 'html', 'yaml', 'toml']);

/** Returns the set of 1-based line numbers occupied by YAML/TOML front-matter. */
function frontMatterLines(sourceLines: readonly string[]): Set<number> {
  const excluded = new Set<number>();
  if (sourceLines.length === 0) return excluded;

  const first = sourceLines[0] ?? '';
  const delimiter = first === '---' ? '---' : first === '+++' ? '+++' : null;
  if (delimiter === null) return excluded;

  // Mark line 1 (the opening delimiter)
  excluded.add(1);

  for (let i = 1; i < sourceLines.length; i++) {
    // Lines inside and including the closing delimiter are excluded (1-based)
    excluded.add(i + 1);
    if (sourceLines[i] === delimiter) {
      break;
    }
  }

  return excluded;
}

function collectLines(
  node: Node,
  sourceLines: readonly string[],
  seen: Set<number>,
  excluded: Set<number>,
  result: ProseLine[],
): void {
  if (SKIP_TYPES.has(node.type)) {
    return;
  }

  const pos = node.position;
  if (pos !== undefined && pos !== null) {
    const start = pos.start.line;
    const end = pos.end.line;

    const isParent = 'children' in node && Array.isArray((node as Parent).children);

    if (!isParent) {
      for (let ln = start; ln <= end; ln++) {
        if (!seen.has(ln) && !excluded.has(ln)) {
          seen.add(ln);
          const text = sourceLines[ln - 1] ?? '';
          result.push({ line: ln, text });
        }
      }
    } else {
      for (const child of (node as Parent).children) {
        collectLines(child, sourceLines, seen, excluded, result);
      }
    }
  }
}

export function extractProseLines(content: string): ProseLine[] {
  const sourceLines = content.split('\n');
  const excluded = frontMatterLines(sourceLines);

  // Strip front-matter before parsing so that remark doesn't misinterpret it.
  // We replace excluded lines with blank lines to preserve line numbers.
  let parseContent = content;
  if (excluded.size > 0) {
    const stripped = sourceLines.map((line, idx) =>
      excluded.has(idx + 1) ? '' : line,
    );
    parseContent = stripped.join('\n');
  }

  const tree = unified().use(remarkParse).parse(parseContent) as Root;
  const seen = new Set<number>();
  const result: ProseLine[] = [];

  for (const child of tree.children) {
    collectLines(child, sourceLines, seen, excluded, result);
  }

  result.sort((a, b) => a.line - b.line);
  return result;
}
