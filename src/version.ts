/**
 * Single source of the package version, read from the shipped package.json.
 *
 * `package.json` is always included in the npm tarball, and `createRequire`
 * resolves it relative to this module (dist/version.js -> ../package.json),
 * so this works both from the built package and from source under tests.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;

/** Polite-pool User-Agent base, e.g. `bibcheck/0.1.0`. */
export const USER_AGENT_BASE = `bibcheck/${VERSION}`;
