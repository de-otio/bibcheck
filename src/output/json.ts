/**
 * JSON renderer for bibcheck output.
 *
 * Round-trip property: the JSON produced by renderJson is guaranteed to
 * validate against OutputSchema. Callers can safely parse the output back
 * through OutputSchema.parse(JSON.parse(text)) and obtain an identical
 * validated object.
 */

import type { Output } from '../schema/output.js';
import { OutputSchema } from '../schema/output.js';

/**
 * Render a validated Output as a JSON string.
 *
 * @param output - A validated Output object.
 * @param opts.pretty - When true (default), produce 2-space-indented JSON.
 *   When false, produce minified JSON.
 * @returns The JSON string, always terminated with a trailing newline.
 */
export function renderJson(output: Output, opts?: { pretty?: boolean }): string {
  // Validate first so the caller gets a clear error if they pass an invalid object.
  const validated = OutputSchema.parse(output);
  const pretty = opts?.pretty !== false; // default true
  return JSON.stringify(validated, null, pretty ? 2 : 0) + '\n';
}
