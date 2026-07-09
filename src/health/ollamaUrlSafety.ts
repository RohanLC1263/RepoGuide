/** Loopback hostnames RepoGuide treats as "this machine" -- IPv6 loopback is
 * matched with or without the URL's `[...]` bracket form. Deliberately kept
 * dependency-free (no `vscode` import) so this decision logic is directly
 * unit-testable under plain `node:test`, unlike startupCheck.ts itself. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * True when `ollamaUrl` resolves to this machine. Security review finding F2:
 * "local by default" is a load-bearing privacy claim -- indexed repository
 * content (file text, chunks, and structural data such as redacted-but-still-
 * present .env key names) is sent to whatever this URL points at. A malformed
 * URL is NOT treated as loopback (fails closed to "warn"), since silently
 * assuming safety on unparseable input is the wrong default here.
 */
export function isLoopbackOllamaUrl(ollamaUrl: string): boolean {
    try {
        const hostname = new URL(ollamaUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return LOOPBACK_HOSTNAMES.has(hostname);
    } catch {
        return false;
    }
}
