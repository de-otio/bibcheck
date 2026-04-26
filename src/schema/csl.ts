/**
 * Minimal CSL-JSON entry schema for bibcheck.
 *
 * CSL JSON is a large spec; bibcheck only consumes a small subset (citekey,
 * identifiers, title, authors, year, URL, note, page). This schema validates
 * that subset at the bibliography-load boundary so subcommand modules
 * (existence, canonical, linkage, worklist) can rely on a typed `CslEntry`.
 *
 * Unknown fields are passed through (CSL JSON producers are diverse), so this
 * uses `.passthrough()` and lets consumers ignore what they don't need.
 *
 * Field-name policy: CSL JSON conventionally uses `URL` (uppercase). bibcheck
 * accepts both `URL` and `url`; the schema normalizes to the lowercase `url`
 * during parse.
 */

import { z } from 'zod';

export const CslAuthorSchema = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
}).passthrough();
export type CslAuthor = z.infer<typeof CslAuthorSchema>;

export const CslDateSchema = z.object({
  'date-parts': z.array(z.array(z.union([z.number(), z.string()]))).optional(),
  literal: z.string().optional(),
  raw: z.string().optional(),
}).passthrough();
export type CslDate = z.infer<typeof CslDateSchema>;

const CslEntryRawSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  author: z.array(CslAuthorSchema).optional(),
  DOI: z.string().optional(),
  doi: z.string().optional(),
  ISBN: z.union([z.string(), z.array(z.string())]).optional(),
  isbn: z.union([z.string(), z.array(z.string())]).optional(),
  URL: z.string().optional(),
  url: z.string().optional(),
  issued: CslDateSchema.optional(),
  note: z.string().optional(),
  page: z.string().optional(),
  publisher: z.string().optional(),
  'container-title': z.string().optional(),
}).passthrough();

export const CslEntrySchema = CslEntryRawSchema.transform((raw) => {
  const isbnRaw = raw.ISBN ?? raw.isbn;
  const isbn = Array.isArray(isbnRaw) ? isbnRaw[0] : isbnRaw;
  return {
    ...raw,
    citekey: typeof raw.id === 'number' ? String(raw.id) : raw.id ?? '',
    doi: raw.DOI ?? raw.doi,
    isbn,
    url: raw.URL ?? raw.url,
  };
});
export type CslEntry = z.infer<typeof CslEntrySchema>;

export const CslBibliographySchema = z.array(CslEntrySchema);
export type CslBibliography = z.infer<typeof CslBibliographySchema>;

export class BibliographyParseError extends Error {
  override name = 'BibliographyParseError' as const;
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, BibliographyParseError);
    }
  }
}

export interface LoadBibliographyOptions {
  path: string;
  cwd?: string;
}

export async function loadBibliography(
  opts: LoadBibliographyOptions,
): Promise<CslBibliography> {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const cwd = opts.cwd ?? process.cwd();
  const fullPath = resolve(cwd, opts.path);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BibliographyParseError(
        `bibliography file not found: ${fullPath}`,
        err,
      );
    }
    throw new BibliographyParseError(
      `failed to read bibliography: ${(err as Error).message}`,
      err,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BibliographyParseError(
      `bibliography is not valid JSON: ${(err as Error).message}`,
      err,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new BibliographyParseError(
      'bibliography must be a JSON array of CSL-JSON entries',
    );
  }
  const result = CslBibliographySchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') ?? '<root>';
    const message = issue?.message ?? 'invalid CSL-JSON entry';
    throw new BibliographyParseError(`${path}: ${message}`, result.error);
  }
  return result.data;
}
