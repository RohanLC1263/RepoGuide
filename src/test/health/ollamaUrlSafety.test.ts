import test from 'node:test';
import * as assert from 'node:assert/strict';
import { isLoopbackOllamaUrl, resolveOllamaUrl, resolveOllamaUrlDetailed, DEFAULT_OLLAMA_URL, OllamaConfigReader } from '../../health/ollamaUrlSafety';

// Security review finding F2: "local by default" must hold in the shipped code, not
// just in intent. isLoopbackOllamaUrl is the exact condition that gates
// startupCheck.ts's one-time non-local-endpoint warning -- kept dependency-free (no
// `vscode` import, unlike startupCheck.ts itself) specifically so this decision logic
// is directly testable under plain node:test.

test('isLoopbackOllamaUrl: the default localhost URL does not fire the warning condition', () => {
    assert.equal(isLoopbackOllamaUrl('http://localhost:11434'), true);
});

test('isLoopbackOllamaUrl: 127.0.0.1 and IPv6 loopback are also treated as local', () => {
    assert.equal(isLoopbackOllamaUrl('http://127.0.0.1:11434'), true);
    assert.equal(isLoopbackOllamaUrl('http://[::1]:11434'), true);
});

test('isLoopbackOllamaUrl: localhost/127.0.0.1 with no explicit port, or with a path, are still local', () => {
    assert.equal(isLoopbackOllamaUrl('http://localhost'), true);
    assert.equal(isLoopbackOllamaUrl('http://127.0.0.1/api'), true);
    assert.equal(isLoopbackOllamaUrl('https://localhost:11434/'), true);
});

test('isLoopbackOllamaUrl: a remote hostname fires the warning condition', () => {
    assert.equal(isLoopbackOllamaUrl('http://ollama.example.com:11434'), false);
    assert.equal(isLoopbackOllamaUrl('https://shared-team-ollama.internal:11434'), false);
});

test('isLoopbackOllamaUrl: a remote IP address fires the warning condition', () => {
    assert.equal(isLoopbackOllamaUrl('http://192.168.1.50:11434'), false);
    assert.equal(isLoopbackOllamaUrl('http://203.0.113.7:11434'), false);
});

test('isLoopbackOllamaUrl: a malformed URL fails closed to "warn" (not silently assumed safe)', () => {
    assert.equal(isLoopbackOllamaUrl('not a url at all'), false);
    assert.equal(isLoopbackOllamaUrl(''), false);
});

test('isLoopbackOllamaUrl: hostname matching is case-insensitive', () => {
    assert.equal(isLoopbackOllamaUrl('http://LOCALHOST:11434'), true);
});

// --- resolveOllamaUrl: enforcement, not just warning -------------------------------
//
// P0-3 follow-up. The warning above already existed; nothing STOPPED a non-loopback URL.
// Reproduced live 2026-08-05: with a workspace .vscode/settings.json pointing ollamaUrl at
// 127.0.0.1:47913, a listener there recorded three hits -- including `GET /` and
// `GET /api/tags` from RepoGuide's own startup health check, i.e. before the warning could
// even be read. These pin the decision logic; the machine-scope half is provable only in a
// real Extension Development Host (src/test/health/ollamaUrlWorkspaceScope.test.ts).

const reader = (values: Record<string, unknown>): OllamaConfigReader => ({
    getConfig: <T>(key: string, defaultValue?: T) =>
        (key in values ? values[key] : defaultValue) as T
});

test('resolveOllamaUrl: the default loopback endpoint is used as-is', () => {
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://localhost:11434' }));
    assert.equal(r.url, 'http://localhost:11434');
    assert.equal(r.outcome, 'local');
});

test('resolveOllamaUrl: a non-loopback endpoint is REFUSED by default, falling back to loopback', () => {
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://evil.example.com:11434' }));
    assert.equal(r.url, DEFAULT_OLLAMA_URL, 'must not hand back the remote endpoint');
    assert.equal(r.outcome, 'remote-blocked');
    assert.equal(r.requested, 'http://evil.example.com:11434', 'the request is retained so it can be disclosed');
});

test('resolveOllamaUrl: the reproduction endpoint is loopback, so GATE 1 is what stops it -- not this function', () => {
    // Worth being exact about, because it is easy to over-claim what this resolver does.
    // The live reproduction pointed ollamaUrl at http://127.0.0.1:47913 -- a listener on
    // *this machine*, just a different port. That IS loopback, so allowRemoteOllama has no
    // opinion on it and the resolver passes it through unchanged, correctly.
    //
    // What actually closes that attack is the OTHER gate: `scope: machine` on
    // repoguide.ollamaUrl, which stops a workspace's .vscode/settings.json from setting it
    // in the first place. This function's job is the different one of stopping data leaving
    // the machine. Both are needed; neither substitutes for the other, and only the real
    // Extension Development Host test can prove the machine-scope half.
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://127.0.0.1:47913' }));
    assert.equal(r.outcome, 'local');
    assert.equal(r.url, 'http://127.0.0.1:47913');
});

test('resolveOllamaUrl: an explicit opt-in permits a genuine remote Ollama', () => {
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://192.168.1.50:11434', allowRemoteOllama: true }));
    assert.equal(r.url, 'http://192.168.1.50:11434', 'LAN Ollama must still work when opted in');
    assert.equal(r.outcome, 'remote-allowed');
});

test('resolveOllamaUrl: the opt-in alone changes nothing for a loopback URL', () => {
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://127.0.0.1:11434', allowRemoteOllama: true }));
    assert.equal(r.outcome, 'local', 'opting in must not relabel a local endpoint as remote');
});

test('resolveOllamaUrl: only a real boolean true opts in, not a truthy string', () => {
    // Config values arrive from JSON and can be any shape.
    for (const bad of ['true', 1, 'yes', {}]) {
        const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'http://evil.example.com', allowRemoteOllama: bad }));
        assert.equal(r.outcome, 'remote-blocked', `${JSON.stringify(bad)} must not count as opting in`);
    }
});

test('resolveOllamaUrl: a malformed URL falls back rather than being trusted or throwing', () => {
    // isLoopbackOllamaUrl fails closed, so an unparseable URL is treated as non-local.
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: 'not-a-url' }));
    assert.equal(r.url, DEFAULT_OLLAMA_URL);
    assert.equal(r.outcome, 'remote-blocked');
});

test('resolveOllamaUrl: an absent or empty setting resolves to the loopback default', () => {
    assert.equal(resolveOllamaUrl(reader({})), DEFAULT_OLLAMA_URL);
    assert.equal(resolveOllamaUrl(reader({ ollamaUrl: '' })), DEFAULT_OLLAMA_URL);
    assert.equal(resolveOllamaUrl(reader({ ollamaUrl: '   ' })), DEFAULT_OLLAMA_URL);
});

test('resolveOllamaUrl: surrounding whitespace does not smuggle a remote host past the check', () => {
    const r = resolveOllamaUrlDetailed(reader({ ollamaUrl: '  http://evil.example.com:11434  ' }));
    assert.equal(r.outcome, 'remote-blocked');
});
