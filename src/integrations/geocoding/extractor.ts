import type { LocationExtractor } from './types.js';
import { GAZETTEER_NAMES } from './gazetteer.js';

// A capitalised token sequence, allowing ", " or " " between tokens: "Manhattan, NYC", "New York City".
// '.' is excluded from tokens so a sentence boundary ("in Manhattan. Residents...") ends the match.
const PLACE = String.raw`[A-Z][\p{L}'-]*(?:(?:,\s*|\s+)(?:of\s+)?[A-Z][\p{L}'-]*)*`;
// Words that typically precede a location in incident reports
const CUE = String.raw`\b(?:in|at|near|around|across|affected|affecting|hit|hits|struck|strikes|over|from|of)\s+(?:the\s+)?`;
const CUE_PATTERN = new RegExp(`${CUE}(${PLACE})`, 'gu');

const NOT_PLACES = new Set(['I', 'We', 'The', 'Help', 'Urgent', 'SOS', 'Emergency', 'Red Cross']);

/**
 * Rule-based extractor, deterministic and dependency-free:
 *  1. the first capitalised phrase following a location cue ("in", "near", "affected", ...)
 *  2. otherwise a known gazetteer place name appearing anywhere in the text (longest match wins)
 *
 * Trade-off: this misses lowercase or unusual phrasing; an LLM/NER extractor can be
 * dropped in behind the LocationExtractor interface without touching callers.
 */
export class RuleBasedLocationExtractor implements LocationExtractor {
  async extract(text: string): Promise<string | null> {
    for (const match of text.matchAll(CUE_PATTERN)) {
      const candidate = cleanup(match[1] ?? '');
      if (candidate && !NOT_PLACES.has(candidate)) return candidate;
    }

    const lower = text.toLowerCase();
    const known = GAZETTEER_NAMES.filter((name) => containsWord(lower, name)).sort((a, b) => b.length - a.length);
    return known[0] ? titleCase(known[0]) : null;
  }
}

function cleanup(raw: string): string {
  return raw.replace(/[.,;:!?'-]+$/u, '').trim();
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}])${escaped}([^\\p{L}]|$)`, 'u').test(haystack);
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
