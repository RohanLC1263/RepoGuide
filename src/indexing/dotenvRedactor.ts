import { detectLanguage } from './languageDetector';

const REDACTED_VALUE = '[REDACTED]';

/** Matches `export? KEY = ` (dotenv/shell assignment syntax). The key-name
 * character class deliberately excludes `=`, so the split point is always
 * the FIRST `=` on the line -- correct even when the value itself contains
 * `=` (common in base64-encoded secrets, e.g. `KEY=abc123==`). */
const ASSIGNMENT_LINE_REGEX = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*)(.*)$/;
/** Fallback for `KEY: VALUE` colon-separated env-like formats (not canonical
 * dotenv syntax, but real-world ".env"-named files sometimes use it). */
const COLON_LINE_REGEX = /^(\s*[A-Za-z_][A-Za-z0-9_.]*\s*:\s*)(.*)$/;

/** True when `filePath` is a file RepoGuide indexes under dotenv rules
 * (`.env`, `.env.local`, `.env.production`, ...) -- the one file category it
 * deliberately indexes whose values are commonly real, live secrets (API
 * keys, DB credentials) rather than source code. Delegates to
 * `detectLanguage` so this can never drift from the walker's own
 * `ALLOWED_INFRA_BASENAMES` definition of what counts as a dotenv file. */
export function isDotenvFile(filePath: string): boolean {
    return detectLanguage(filePath) === 'dotenv';
}

/**
 * Redacts the VALUE side of every `KEY=VALUE` (or `KEY: VALUE`) line in a
 * dotenv file's content, preserving the key name, comments, and blank lines
 * untouched. Callers must run this on dotenv file content BEFORE it can
 * reach an embedding call, an LLM prompt, or any on-disk chunk/fact/unit
 * store -- so "this file defines GEMINI_API_KEY" stays indexable and
 * answerable, but the real key value is never present in an embedding, a
 * prompt sent to Ollama, or `.repoguide/` storage.
 *
 * Deliberately blanket, not secret-shape-based: every value is redacted
 * regardless of whether it "looks like" a secret (`PORT=8080` is redacted
 * the same as `API_KEY=...`) -- heuristically guessing which values are
 * sensitive is unreliable, and the cost of redacting a harmless value is
 * zero.
 *
 * Known, accepted limitation: only single-line `KEY=VALUE`/`KEY: VALUE`
 * assignments are covered. A multi-line PEM/certificate block pasted
 * directly into a .env file (not itself a supported dotenv construct)
 * would not be redacted by this pass.
 */
export function redactDotenvContent(content: string): string {
    return content
        .split('\n')
        .map(line => {
            const trimmed = line.trimStart();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
                return line;
            }
            const assignmentMatch = line.match(ASSIGNMENT_LINE_REGEX);
            if (assignmentMatch) {
                return assignmentMatch[1] + REDACTED_VALUE;
            }
            const colonMatch = line.match(COLON_LINE_REGEX);
            if (colonMatch) {
                return colonMatch[1] + REDACTED_VALUE;
            }
            return line;
        })
        .join('\n');
}
