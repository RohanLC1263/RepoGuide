import test from 'node:test';
import * as assert from 'node:assert/strict';
import { isLoopbackOllamaUrl } from '../../health/ollamaUrlSafety';

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
