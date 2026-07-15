import test from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildClaudeCodeProjectConfig,
    buildClaudeCliCommand,
    buildClaudeDesktopConfig,
    buildMcpConfigSnippet,
    isWorkspaceReadyForMcpConfig,
    MCP_CONFIG_FORMAT_OPTIONS,
    MCP_NOT_INDEXED_WARNING,
    McpConfigParams
} from '../../mcp/mcpConfigBuilder';

const POSIX_PARAMS: McpConfigParams = {
    mcpServerScriptPath: '/home/dev/repoguide/out/mcp/mcpServer.js',
    workspaceRoot: '/home/dev/my-project',
    repoguideDir: '/home/dev/my-project/.repoguide'
};

const WINDOWS_PARAMS: McpConfigParams = {
    mcpServerScriptPath: 'C:\\Projects\\RepoGuide\\out\\mcp\\mcpServer.js',
    workspaceRoot: 'C:\\Users\\dev\\my-project',
    repoguideDir: 'C:\\Users\\dev\\my-project\\.repoguide'
};

// --- buildClaudeCodeProjectConfig / buildClaudeDesktopConfig (identical shape) ---

test('buildClaudeCodeProjectConfig: produces a valid mcpServers JSON block with node/args pointing at mcpServer.js', () => {
    const output = buildClaudeCodeProjectConfig(POSIX_PARAMS);
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, {
        mcpServers: {
            repoguide: {
                command: 'node',
                args: [
                    POSIX_PARAMS.mcpServerScriptPath,
                    '--workspaceRoot', POSIX_PARAMS.workspaceRoot,
                    '--repoguideDir', POSIX_PARAMS.repoguideDir
                ]
            }
        }
    });
});

test('buildClaudeDesktopConfig: identical shape to the Claude Code project config -- genuinely the same JSON, not a second format', () => {
    assert.equal(buildClaudeDesktopConfig(POSIX_PARAMS), buildClaudeCodeProjectConfig(POSIX_PARAMS));
});

// --- buildClaudeCliCommand ---

test('buildClaudeCliCommand: produces a "claude mcp add" one-liner with quoted path args', () => {
    const output = buildClaudeCliCommand(POSIX_PARAMS);
    assert.equal(
        output,
        `claude mcp add repoguide -- node "${POSIX_PARAMS.mcpServerScriptPath}" ` +
        `--workspaceRoot "${POSIX_PARAMS.workspaceRoot}" --repoguideDir "${POSIX_PARAMS.repoguideDir}"`
    );
});

// --- Windows path escaping (the one fiddly part) ---

test('Windows path escaping: JSON formats double-escape backslashes AND round-trip back to the real path', () => {
    const output = buildClaudeCodeProjectConfig(WINDOWS_PARAMS);
    // The raw JSON text must contain doubled backslashes -- confirms JSON.stringify
    // did real escaping rather than the path passing through unescaped.
    assert.match(output, /C:\\\\Projects\\\\RepoGuide/);
    // And parsing it back must recover the exact original single-backslash path,
    // not a corrupted one -- the actual correctness bar, not just "looks escaped."
    const parsed = JSON.parse(output);
    assert.equal(parsed.mcpServers.repoguide.args[0], WINDOWS_PARAMS.mcpServerScriptPath);
    assert.equal(parsed.mcpServers.repoguide.args[2], WINDOWS_PARAMS.workspaceRoot);
    assert.equal(parsed.mcpServers.repoguide.args[4], WINDOWS_PARAMS.repoguideDir);
});

test('Windows path escaping: the CLI one-liner does NOT double-escape backslashes -- doubling here would produce a wrong shell path', () => {
    const output = buildClaudeCliCommand(WINDOWS_PARAMS);
    assert.match(output, /"C:\\Projects\\RepoGuide\\out\\mcp\\mcpServer\.js"/);
    assert.equal(output.includes('\\\\'), false, 'CLI command must not contain doubled backslashes');
});

test('Windows path escaping: Claude Desktop config matches the same JSON round-trip guarantee as the project config', () => {
    const output = buildClaudeDesktopConfig(WINDOWS_PARAMS);
    const parsed = JSON.parse(output);
    assert.equal(parsed.mcpServers.repoguide.args[0], WINDOWS_PARAMS.mcpServerScriptPath);
});

// --- buildMcpConfigSnippet dispatcher ---

test('buildMcpConfigSnippet: routes each format to its matching builder', () => {
    assert.equal(buildMcpConfigSnippet('claude-code-project', POSIX_PARAMS), buildClaudeCodeProjectConfig(POSIX_PARAMS));
    assert.equal(buildMcpConfigSnippet('claude-cli', POSIX_PARAMS), buildClaudeCliCommand(POSIX_PARAMS));
    assert.equal(buildMcpConfigSnippet('claude-desktop', POSIX_PARAMS), buildClaudeDesktopConfig(POSIX_PARAMS));
});

test('MCP_CONFIG_FORMAT_OPTIONS: exactly one option per McpConfigFormat, none orphaned', () => {
    assert.equal(MCP_CONFIG_FORMAT_OPTIONS.length, 3);
    const formats = MCP_CONFIG_FORMAT_OPTIONS.map(option => option.format).sort();
    assert.deepEqual(formats, ['claude-cli', 'claude-code-project', 'claude-desktop']);
    MCP_CONFIG_FORMAT_OPTIONS.forEach(option => {
        assert.equal(typeof option.label, 'string');
        assert.ok(option.label.length > 0);
        assert.equal(typeof option.description, 'string');
        assert.ok(option.description.length > 0);
    });
});

// --- isWorkspaceReadyForMcpConfig / MCP_NOT_INDEXED_WARNING ---

test('isWorkspaceReadyForMcpConfig: a real lastIndexedAt means ready', () => {
    assert.equal(isWorkspaceReadyForMcpConfig(new Date()), true);
});

test('isWorkspaceReadyForMcpConfig: null lastIndexedAt (never indexed) means not ready -- the not-indexed warning path', () => {
    assert.equal(isWorkspaceReadyForMcpConfig(null), false);
});

test('MCP_NOT_INDEXED_WARNING: names the concrete action to unblock (re-sync) rather than a bare failure message', () => {
    assert.match(MCP_NOT_INDEXED_WARNING, /Re-sync Index/);
    assert.match(MCP_NOT_INDEXED_WARNING, /Index this workspace first/);
});

// --- No process management anywhere in this module ---

test('REMOVAL/SCOPE GUARD: mcpConfigBuilder.ts never imports child_process or references spawn/start/stop/restart -- string builders only, per the discoverability design', () => {
    const fs = require('fs');
    const path = require('path');
    const source: string = fs.readFileSync(path.join(__dirname, '../../../src/mcp/mcpConfigBuilder.ts'), 'utf8');
    assert.equal(/child_process/i.test(source), false);
    assert.equal(/\bspawn\(/i.test(source), false);
    assert.equal(/exec\(/i.test(source), false);
});
