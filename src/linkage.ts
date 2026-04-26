/**
 * Linkage subcommand: verify that every @citekey reference in the markdown
 * documents resolves to an entry in the bibliography.
 *
 * For each citekey found in prose, emits a LinkageEntry with status
 * 'resolved' or 'unresolved' and the full list of file:line references.
 * Bibliography entries that are never referenced in docs are NOT emitted.
 */

import { discoverDocs } from './markdown/glob.js';
import { extractCitekeys } from './markdown/citekeys.js';
import type { CslEntry } from './schema/csl.js';
import type { LinkageEntry, LinkageReference } from './schema/output.js';
import type { Config } from './config.js';

export interface RunLinkageDeps {
  config: Config;
  cwd: string;
  bibliography: CslEntry[];
  readFile: (path: string) => Promise<string>;
  signal: AbortSignal;
}

export interface RunLinkageResult {
  linkage: LinkageEntry[];
}

export async function runLinkage(deps: RunLinkageDeps): Promise<RunLinkageResult> {
  const { config, cwd, bibliography, readFile, signal } = deps;

  // Step 1: Discover docs
  const docs = await discoverDocs({
    cwd,
    include: config.docs.include,
    exclude: config.docs.exclude,
  });

  // Step 2: Build bibliography citekey set
  const bibKeys = new Set(bibliography.map((e) => e.citekey));

  // Step 3: Process each doc, aggregate references by citekey
  const referenceMap = new Map<string, LinkageReference[]>();

  for (const doc of docs) {
    if (signal.aborted) {
      const err = new Error('runLinkage aborted');
      err.name = 'AbortError';
      throw err;
    }

    const content = await readFile(doc.path);
    const citekeyRefs = extractCitekeys(content, doc.relativePath);

    for (const ref of citekeyRefs) {
      let refs = referenceMap.get(ref.citekey);
      if (refs === undefined) {
        refs = [];
        referenceMap.set(ref.citekey, refs);
      }
      refs.push({ file: ref.file, line: ref.line });
    }
  }

  // Step 4: Build LinkageEntry array
  const linkage: LinkageEntry[] = [];

  for (const [citekey, references] of referenceMap) {
    linkage.push({
      citekey,
      status: bibKeys.has(citekey) ? 'resolved' : 'unresolved',
      references,
    });
  }

  // Step 5: Sort by citekey for deterministic output
  linkage.sort((a, b) => a.citekey.localeCompare(b.citekey));

  return { linkage };
}
