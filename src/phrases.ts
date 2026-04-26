/**
 * `bibcheck phrases` subcommand.
 *
 * Performs a regex pass over markdown prose lines against a project-supplied
 * phrase denylist, with `<!-- bibcheck-allow: <key> -->` acknowledgement-comment
 * detection.
 *
 * Patterns are pre-compiled by the caller (buildCheckDeps / T13 / T15) and
 * passed in via `RunPhrasesDeps.patterns`. When the array is empty (no
 * denylist configured), the function short-circuits immediately without
 * touching the filesystem.
 */

import type { Config } from './config.js';
import type { PhraseFlag } from './schema/output.js';
import type { CompiledPattern } from './phrases/load.js';
import { discoverDocs } from './markdown/glob.js';
import { extractProseLines } from './markdown/prose.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunPhrasesDeps {
  config: Config;
  cwd: string;
  patterns: CompiledPattern[]; // pre-loaded by buildCheckDeps (T13/T15)
  readFile: (path: string) => Promise<string>;
  signal: AbortSignal;
}

export interface RunPhrasesResult {
  phraseFlags: PhraseFlag[];
}

// ---------------------------------------------------------------------------
// Acknowledgement comment regex
//
// Matches: <!-- bibcheck-allow: <key> -->
// The key must consist of word characters and hyphens.
// ---------------------------------------------------------------------------

const ALLOW_COMMENT_RE = /<!--\s*bibcheck-allow:\s*([\w-]+)\s*-->/i;

/**
 * Return the set of pattern keys acknowledged in a given text string.
 * A single line may contain multiple acknowledgement comments, so we use
 * matchAll to collect them all.
 */
function acknowledgedKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const globalRe = /<!--\s*bibcheck-allow:\s*([\w-]+)\s*-->/gi;
  for (const m of text.matchAll(globalRe)) {
    const key = m[1];
    if (key !== undefined) {
      keys.add(key);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// runPhrases
// ---------------------------------------------------------------------------

export async function runPhrases(deps: RunPhrasesDeps): Promise<RunPhrasesResult> {
  const { config, cwd, patterns, readFile, signal } = deps;

  // Fast-path: no patterns configured → nothing to do.
  if (patterns.length === 0) {
    return { phraseFlags: [] };
  }

  // Throw immediately if already aborted.
  if (signal.aborted) {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw signal.reason as unknown;
  }

  const docs = await discoverDocs({
    cwd,
    include: config.docs.include,
    exclude: config.docs.exclude,
  });

  const phraseFlags: PhraseFlag[] = [];

  for (const doc of docs) {
    // Check abort between documents.
    if (signal.aborted) {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw signal.reason as unknown;
    }

    const content = await readFile(doc.path);
    const proseLines = extractProseLines(content);

    // Build a map of line-number → text for fast preceding-line lookup.
    // extractProseLines returns only prose lines (excluding code blocks,
    // inline code, HTML comments, front-matter), sorted by line number.
    const lineTextMap = new Map<number, string>();
    for (const pl of proseLines) {
      lineTextMap.set(pl.line, pl.text);
    }

    for (const { line, text } of proseLines) {
      // Collect acknowledged keys from the current line and the immediately
      // preceding source line (which may or may not itself be a prose line).
      // We look up the raw content for the preceding line from the full
      // source split, but extractProseLines already excluded that line from
      // being reported as prose, so we need the raw source for the
      // acknowledgement check.
      //
      // Strategy: split the full content into raw lines and use line-1 for
      // the preceding raw text. We rebuild this cheaply per-document.
      //
      // NOTE: This is computed lazily only when a match is found to avoid
      // splitting on every prose line.  We'll split once per document below.
      const rawLines = content.split('\n');
      const prevRawText = line > 1 ? (rawLines[line - 2] ?? '') : '';

      const currentKeys = acknowledgedKeys(text);
      const prevKeys = acknowledgedKeys(prevRawText);

      for (const pattern of patterns) {
        // Use a RE2JS Matcher to find ALL matches on this prose line.
        const matcher = pattern.compiled.matcher(text);

        while (matcher.find()) {
          const matchedText = matcher.group();
          if (matchedText === null) {
            // Should not happen for a successful find(), but guard defensively.
            continue;
          }

          // Determine acknowledgement status.
          const isAcknowledged =
            currentKeys.has(pattern.key) || prevKeys.has(pattern.key);

          const flag: PhraseFlag = {
            status: isAcknowledged ? 'acknowledged' : 'flagged',
            patternKey: pattern.key,
            referenceUrl: pattern.referenceUrl,
            file: doc.relativePath,
            line,
            matchedText,
          };

          phraseFlags.push(flag);
        }
      }
    }
  }

  return { phraseFlags };
}
