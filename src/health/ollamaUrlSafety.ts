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

/** The loopback endpoint everything falls back to. Matches package.json's declared default. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Minimal shape both config sources satisfy: RepositoryContext.getConfig and a thin
 *  wrapper over vscode.workspace.getConfiguration('repoguide'). Keeping it structural is
 *  what lets this module stay `vscode`-free and directly unit-testable. */
export interface OllamaConfigReader {
    getConfig<T>(key: string, defaultValue?: T): T;
}

export type OllamaUrlOutcome = 'local' | 'remote-allowed' | 'remote-blocked';

export interface OllamaUrlResolution {
    /** The endpoint that will actually be contacted. Never non-loopback unless opted in. */
    url: string;
    /** What the setting asked for, retained so callers can explain a block to the user. */
    requested: string;
    outcome: OllamaUrlOutcome;
}

/**
 * Decides which Ollama endpoint RepoGuide is allowed to contact.
 *
 * WHY ENFORCEMENT AND NOT JUST A WARNING. Before this existed, `repoguide.ollamaUrl` had a
 * startup warning but nothing stopped it: ~7 call sites read the setting independently and
 * used it unchecked. Reproduced live on 2026-08-05 against a workspace whose
 * `.vscode/settings.json` pointed the URL at a listener on 127.0.0.1:47913 -- the listener
 * recorded three hits, and two of them (`GET /` and `GET /api/tags`) came from RepoGuide's
 * own startup health check, i.e. before a user could even read the warning, let alone
 * dismiss it. A dismissible, one-time warning is not a control.
 *
 * Two independent gates now apply, and both must pass for anything to leave this machine:
 *   1. `repoguide.ollamaUrl` is `scope: machine`, so a workspace cannot set it at all.
 *      That closes the attack in the settings resolver, above this code.
 *   2. This function refuses a non-loopback endpoint unless `repoguide.allowRemoteOllama`
 *      (also machine-scoped) is explicitly true, falling back to loopback instead.
 *
 * Gate 2 exists because gate 1 alone would silently permit any non-loopback URL a user
 * once typed into User settings, and because defence in depth is cheap here: a future
 * settings-scope regression should not silently re-open exfiltration.
 *
 * Falling back rather than throwing is deliberate. A hard failure on a misconfigured URL
 * would take the whole extension down; falling back to loopback keeps RepoGuide working
 * exactly as a "fully local" tool is supposed to, which is the safe direction to fail.
 */
export function resolveOllamaUrlDetailed(reader: OllamaConfigReader): OllamaUrlResolution {
    const requested = (reader.getConfig<string>('ollamaUrl', DEFAULT_OLLAMA_URL) || DEFAULT_OLLAMA_URL).trim();

    if (isLoopbackOllamaUrl(requested)) {
        return { url: requested, requested, outcome: 'local' };
    }
    const remoteAllowed = reader.getConfig<boolean>('allowRemoteOllama', false) === true;
    return remoteAllowed
        ? { url: requested, requested, outcome: 'remote-allowed' }
        : { url: DEFAULT_OLLAMA_URL, requested, outcome: 'remote-blocked' };
}

/**
 * The endpoint every network call site must use. This is the ONLY place
 * `repoguide.ollamaUrl` should be read; a new call site reading it directly bypasses both
 * gates above, which is exactly the shape that made this a finding in the first place.
 */
export function resolveOllamaUrl(reader: OllamaConfigReader): string {
    return resolveOllamaUrlDetailed(reader).url;
}

/**
 * Adapts a `vscode.workspace.getConfiguration('repoguide')` object to OllamaConfigReader.
 * Typed structurally so this module still imports nothing from `vscode` and stays
 * unit-testable; callers pass the real configuration object.
 */
export function vscodeConfigReader(
    config: { get<T>(section: string, defaultValue: T): T }
): OllamaConfigReader {
    return { getConfig: <T>(key: string, defaultValue?: T) => config.get(key, defaultValue as T) };
}
