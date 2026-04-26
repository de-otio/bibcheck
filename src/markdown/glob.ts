/**
 * File discovery using tinyglobby include/exclude patterns.
 *
 * Returns discovered markdown files as absolute paths with a relative path
 * computed against the cwd. Results are sorted alphabetically by relativePath
 * for deterministic ordering.
 */

import { glob } from 'tinyglobby';
import { relative } from 'node:path';

export type DiscoverDocsOptions = {
  cwd: string;
  include: string[];   // e.g. ["docs/**/*.md"]
  exclude?: string[];  // e.g. ["**/node_modules/**"]
};

export type DiscoveredDoc = {
  path: string;         // absolute path
  relativePath: string; // relative to cwd
};

export async function discoverDocs(opts: DiscoverDocsOptions): Promise<DiscoveredDoc[]> {
  if (opts.include.length === 0) {
    return [];
  }

  const absolutePaths = await glob(opts.include, {
    cwd: opts.cwd,
    ignore: opts.exclude ?? [],
    absolute: true,
  });

  const docs: DiscoveredDoc[] = absolutePaths.map((p) => ({
    path: p,
    relativePath: relative(opts.cwd, p),
  }));

  docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return docs;
}
