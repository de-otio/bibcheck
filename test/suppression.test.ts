/**
 * Unit tests for src/suppression.ts — the pure T23 resolution layer.
 *
 * Covers both sides of every gate decision: default-gate vs source-type
 * exemption vs per-entry allow, the precedence between them, and the
 * reason-mandatory rule for allows.
 */

import { describe, it, expect } from 'vitest';
import {
  isGated,
  parseAllows,
  parseAllowsForBibliography,
  FINDING_TYPES,
  type ParsedAllow,
} from '../src/suppression.js';
import type { Config } from '../src/config.js';

// Minimal config builder — only `source_types` matters to isGated.
function cfg(sourceTypes: Config['source_types'] = {}): Config {
  return {
    bibliography: { file: 'docs/sources.json' },
    docs: { include: ['docs/**/*.md'], exclude: [] },
    trusted_hosts: { hosts: [] },
    phrases: { file: null },
    source_types: sourceTypes,
    edition_discipline: {},
    apis: {
      crossref_mailto: null,
      openalex_mailto: null,
    },
    cache: { dir: '.bibcheck-cache', max_size_mb: 256 },
  } as Config;
}

// ---------------------------------------------------------------------------
// parseAllows
// ---------------------------------------------------------------------------

describe('parseAllows', () => {
  it('returns nothing for an absent or empty note', () => {
    expect(parseAllows('k', undefined)).toEqual({ allows: [], unknownTypes: [] });
    expect(parseAllows('k', '')).toEqual({ allows: [], unknownTypes: [] });
  });

  it('parses a single directive with a reason', () => {
    const r = parseAllows('manu1', 'bibcheck-allow: not-found (reason: 1680 pamphlet, Bodleian shelfmark X)');
    expect(r.unknownTypes).toEqual([]);
    expect(r.allows).toHaveLength(1);
    expect(r.allows[0]).toMatchObject({
      citekey: 'manu1',
      findingType: 'not-found',
      reason: '1680 pamphlet, Bodleian shelfmark X',
    });
  });

  it('records a missing reason as null (does not throw)', () => {
    const r = parseAllows('k', 'bibcheck-allow: not-found');
    expect(r.allows).toHaveLength(1);
    expect(r.allows[0]?.reason).toBeNull();
  });

  it('records an empty reason as null', () => {
    const r = parseAllows('k', 'bibcheck-allow: not-found (reason:   )');
    expect(r.allows).toHaveLength(1);
    expect(r.allows[0]?.reason).toBeNull();
  });

  it('parses multiple directives in one note', () => {
    const note =
      'bibcheck-allow: not-found (reason: archival) and bibcheck-allow: malformed-identifier (reason: legacy DOI)';
    const r = parseAllows('k', note);
    expect(r.allows.map((a) => a.findingType)).toEqual(['not-found', 'malformed-identifier']);
  });

  it('flags an unknown finding-type token without suppressing', () => {
    const r = parseAllows('k', 'bibcheck-allow: not-a-finding (reason: typo)');
    expect(r.allows).toEqual([]);
    expect(r.unknownTypes).toHaveLength(1);
    expect(r.unknownTypes[0]?.token).toBe('not-a-finding');
  });

  it('is case-insensitive on the directive keyword', () => {
    const r = parseAllows('k', 'BIBCHECK-ALLOW: not-found (reason: x)');
    expect(r.allows).toHaveLength(1);
  });

  it('ignores ordinary prose notes', () => {
    const r = parseAllows('k', 'See the introduction, page 12.');
    expect(r).toEqual({ allows: [], unknownTypes: [] });
  });
});

describe('parseAllowsForBibliography', () => {
  it('aggregates across entries', () => {
    const r = parseAllowsForBibliography([
      { citekey: 'a', note: 'bibcheck-allow: not-found (reason: r1)' },
      { citekey: 'b', note: undefined },
      { citekey: 'c', note: 'bibcheck-allow: bogus (reason: r)' },
    ]);
    expect(r.allows.map((a) => a.citekey)).toEqual(['a']);
    expect(r.unknownTypes.map((u) => u.citekey)).toEqual(['c']);
  });
});

// ---------------------------------------------------------------------------
// isGated — default
// ---------------------------------------------------------------------------

describe('isGated – secure default', () => {
  it('gates a not-found for an unlisted source type', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg(),
      allows: [],
    });
    expect(r).toEqual({ gated: true, reason: 'default' });
  });

  it('gates a not-found when cslType is undefined', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'not-found',
      cslType: undefined,
      config: cfg(),
      allows: [],
    });
    expect(r.gated).toBe(true);
  });

  it('gates a malformed-identifier by default (source-type rules do not exempt it)', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'malformed-identifier',
      cslType: 'manuscript',
      config: cfg({ manuscript: { gate_not_found: false } }),
      allows: [],
    });
    expect(r).toEqual({ gated: true, reason: 'default' });
  });
});

// ---------------------------------------------------------------------------
// isGated — source-type exemption
// ---------------------------------------------------------------------------

describe('isGated – source-type exemption', () => {
  it('does NOT gate a not-found for a type with gate_not_found = false', () => {
    const r = isGated({
      citekey: 'm',
      findingType: 'not-found',
      cslType: 'manuscript',
      config: cfg({ manuscript: { gate_not_found: false } }),
      allows: [],
    });
    expect(r).toEqual({ gated: false, reason: 'source-type' });
  });

  it('still gates when the type sets gate_not_found = true explicitly', () => {
    const r = isGated({
      citekey: 'a',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg({ 'article-journal': { gate_not_found: true } }),
      allows: [],
    });
    expect(r).toEqual({ gated: true, reason: 'default' });
  });

  it('still gates when the type entry exists but omits gate_not_found', () => {
    const r = isGated({
      citekey: 'a',
      findingType: 'not-found',
      cslType: 'book',
      config: cfg({ book: { warn_load_bearing: true } }),
      allows: [],
    });
    expect(r.gated).toBe(true);
  });

  it('source-type exemption does not apply to canonical-issue', () => {
    const r = isGated({
      citekey: 'm',
      findingType: 'canonical-issue',
      cslType: 'manuscript',
      config: cfg({ manuscript: { gate_not_found: false } }),
      allows: [],
    });
    expect(r.gated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGated — per-entry allow
// ---------------------------------------------------------------------------

describe('isGated – per-entry allow', () => {
  const allow = (over: Partial<ParsedAllow>): ParsedAllow => ({
    citekey: 'x',
    findingType: 'not-found',
    reason: 'archival',
    raw: 'bibcheck-allow: not-found (reason: archival)',
    ...over,
  });

  it('suppresses when a matching allow with a reason exists', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg(),
      allows: [allow({})],
    });
    expect(r).toEqual({ gated: false, reason: 'allow' });
  });

  it('does NOT suppress when the reason is missing (mandatory reason)', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg(),
      allows: [allow({ reason: null })],
    });
    expect(r).toEqual({ gated: true, reason: 'default' });
  });

  it('only suppresses the matching finding type', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'malformed-identifier',
      cslType: 'article-journal',
      config: cfg(),
      allows: [allow({ findingType: 'not-found' })],
    });
    expect(r.gated).toBe(true);
  });

  it('only suppresses the matching citekey', () => {
    const r = isGated({
      citekey: 'other',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg(),
      allows: [allow({ citekey: 'x' })],
    });
    expect(r.gated).toBe(true);
  });

  it('allows a malformed-identifier that source-types cannot exempt', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'malformed-identifier',
      cslType: 'article-journal',
      config: cfg(),
      allows: [allow({ findingType: 'malformed-identifier', reason: 'legacy DOI' })],
    });
    expect(r).toEqual({ gated: false, reason: 'allow' });
  });
});

// ---------------------------------------------------------------------------
// isGated — precedence
// ---------------------------------------------------------------------------

describe('isGated – precedence', () => {
  it('allow beats default', () => {
    const r = isGated({
      citekey: 'x',
      findingType: 'not-found',
      cslType: 'article-journal',
      config: cfg(),
      allows: [
        { citekey: 'x', findingType: 'not-found', reason: 'r', raw: '' },
      ],
    });
    expect(r.reason).toBe('allow');
  });

  it('allow reported even when a source-type exemption also applies', () => {
    const r = isGated({
      citekey: 'm',
      findingType: 'not-found',
      cslType: 'manuscript',
      config: cfg({ manuscript: { gate_not_found: false } }),
      allows: [{ citekey: 'm', findingType: 'not-found', reason: 'r', raw: '' }],
    });
    // Both would suppress; allow takes precedence in the reported reason.
    expect(r).toEqual({ gated: false, reason: 'allow' });
  });
});

describe('FINDING_TYPES vocabulary', () => {
  it('contains the four gateable finding kinds', () => {
    expect(FINDING_TYPES).toEqual([
      'not-found',
      'malformed-identifier',
      'canonical-issue',
      'metadata-mismatch',
    ]);
  });
});
