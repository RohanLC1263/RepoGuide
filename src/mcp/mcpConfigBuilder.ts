/**
 * Builds ready-to-paste MCP client config snippets for RepoGuide's
 * standalone MCP server, given already-resolved paths -- extracted as a
 * standalone, side-effect-free module (see dependentsResponseBuilder.ts's
 * doc comment for why: mcpServer.ts runs a heavyweight main() as an
 * unconditional side effect of import, so nothing that needs to be unit
 * tested can pull it in just to reuse a shape).
 *
 * The server (see README.md's "MCP Server" section) is a stdio-transport
 * process spawned BY the client, not a service the extension starts,
 * stops, or tracks -- so what a user actually needs is the exact
 * command/args their client should invoke, not a "start server" button.
 * All three formats below produce that same invocation (`node
 * <mcpServerScriptPath> --workspaceRoot <workspaceRoot> --repoguideDir
 * <repoguideDir>`) in the shape each target expects. Nothing here spawns
 * or tracks a process -- these are pure string builders only.
 */

export interface McpConfigParams {
    /** Absolute, node-invokable path to mcpServer.js (out/mcp/mcpServer.js
     * next to the running extension, or a dev checkout's compiled output). */
    mcpServerScriptPath: string;
    workspaceRoot: string;
    repoguideDir: string;
}

export type McpConfigFormat = 'claude-code-project' | 'claude-cli' | 'claude-desktop';

export interface McpConfigFormatOption {
    format: McpConfigFormat;
    label: string;
    description: string;
}

const SERVER_NAME = 'repoguide';

/** Shared source of truth for the QuickPick this backs, so its labels/
 * descriptions can't drift from the formats actually implemented below. */
export const MCP_CONFIG_FORMAT_OPTIONS: McpConfigFormatOption[] = [
    {
        format: 'claude-code-project',
        label: 'Claude Code (project .mcp.json)',
        description: 'Save as .mcp.json at your workspace root'
    },
    {
        format: 'claude-cli',
        label: 'Claude Code CLI (claude mcp add)',
        description: 'Run in a terminal to register the server'
    },
    {
        format: 'claude-desktop',
        label: 'Claude Desktop (claude_desktop_config.json)',
        description: "Merge into claude_desktop_config.json's mcpServers"
    }
];

function serverArgs(params: McpConfigParams): string[] {
    return [
        params.mcpServerScriptPath,
        '--workspaceRoot',
        params.workspaceRoot,
        '--repoguideDir',
        params.repoguideDir
    ];
}

/**
 * Claude Code's project-level `.mcp.json` and Claude Desktop's
 * `claude_desktop_config.json` use the identical `mcpServers` shape --
 * genuinely the same JSON, not two formats that happen to look similar --
 * so one builder backs both public functions below. Building a real object
 * and running it through JSON.stringify (rather than hand-templating a
 * string) is what makes a Windows path's backslashes come out correctly
 * double-escaped in the output -- see mcpConfigBuilder.test.ts's Windows-path
 * test for why that matters: a hand-templated string here would silently
 * produce a JSON value that doesn't round-trip back to the real path.
 */
function buildMcpServersJson(params: McpConfigParams): string {
    const config = {
        mcpServers: {
            [SERVER_NAME]: {
                command: 'node',
                args: serverArgs(params)
            }
        }
    };
    return JSON.stringify(config, null, 2);
}

/** Claude Code project config -- save as `.mcp.json` at the workspace root. */
export function buildClaudeCodeProjectConfig(params: McpConfigParams): string {
    return buildMcpServersJson(params);
}

/** Claude Desktop config -- merge the `repoguide` entry into
 * `claude_desktop_config.json`'s existing top-level `mcpServers` object. */
export function buildClaudeDesktopConfig(params: McpConfigParams): string {
    return buildMcpServersJson(params);
}

/**
 * `claude mcp add` CLI one-liner. Unlike the JSON formats above, path
 * arguments here are shell-quoted literals, not JSON string values -- a
 * Windows path's backslashes must NOT be doubled here (a doubled
 * backslash is a literal double-backslash once the shell strips the
 * surrounding quotes, which is not the real file path). Double-quoting
 * (not backslash-escaping) is what protects paths containing spaces.
 */
export function buildClaudeCliCommand(params: McpConfigParams): string {
    const quoted = (value: string) => `"${value}"`;
    return [
        'claude', 'mcp', 'add', SERVER_NAME, '--',
        'node', quoted(params.mcpServerScriptPath),
        '--workspaceRoot', quoted(params.workspaceRoot),
        '--repoguideDir', quoted(params.repoguideDir)
    ].join(' ');
}

export function buildMcpConfigSnippet(format: McpConfigFormat, params: McpConfigParams): string {
    switch (format) {
        case 'claude-code-project':
            return buildClaudeCodeProjectConfig(params);
        case 'claude-cli':
            return buildClaudeCliCommand(params);
        case 'claude-desktop':
            return buildClaudeDesktopConfig(params);
    }
}

/** Shown when generating a config would be premature -- the MCP server
 * itself refuses to start against an unindexed workspace
 * (assertRepositoryReady in repositoryReadiness.ts), so a config copied
 * before the first index completes would only fail later, inside
 * whatever client the user pasted it into, with much less legible logs
 * than the extension can surface directly. */
export const MCP_NOT_INDEXED_WARNING =
    'Index this workspace first (RepoGuide: Re-sync Index) before generating an MCP config -- ' +
    'the MCP server refuses to start against an unindexed workspace.';

/**
 * Reuses the exact signal deriveIndexHealthStatusText (gateStatusRendering.js)
 * already treats as "Ready" -- a non-null lastIndexedAt means a completed
 * index exists on disk, which is what the MCP server's own startup check
 * requires. Deliberately not the heavier buildRepositoryReadinessReport()
 * the server itself runs (which does a full async init of every store) --
 * lastIndexedAt is already computed for the sidebar on every health poll,
 * so this pre-check is free rather than a second expensive readiness pass.
 */
export function isWorkspaceReadyForMcpConfig(lastIndexedAt: Date | null): boolean {
    return lastIndexedAt !== null;
}
