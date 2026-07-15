import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

async function main() {
    // Repo root: this script lives in scripts/, so go up one level.
    const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    
    const transport = new StdioClientTransport({
        command: 'node',
        args: ['out/mcp/mcpServer.js', '--workspaceRoot', workspaceRoot, '--repoguideDir', repoguideDir]
    });

    const client = new Client(
        { name: 'mcp-test-runner', version: '1.0.0' },
        { capabilities: {} }
    );

    console.log('Connecting to MCP server...');
    await client.connect(transport);
    console.log('Connected.');

    console.log('\n--- Tool Discovery ---');
    const t0 = Date.now();
    const tools = await client.listTools();
    const t1 = Date.now();
    console.log(JSON.stringify(tools, null, 2));
    console.log(`Latency: ${t1 - t0}ms`);

    // Test 1: get_dependents
    console.log('\n--- Test 1: get_dependents ---');
    const t2 = Date.now();
    const depResult = await client.callTool({
        name: 'get_dependents',
        arguments: { symbol: 'QueryDispatcher' }
    });
    const t3 = Date.now();
    console.log(JSON.stringify(depResult, null, 2));
    console.log(`Latency: ${t3 - t2}ms`);

    // Test 2: get_facts
    console.log('\n--- Test 2: get_facts ---');
    const t4 = Date.now();
    const factResult = await client.callTool({
        name: 'get_facts',
        arguments: { query: 'HybridRetrievalFusion' }
    });
    const t5 = Date.now();
    console.log(JSON.stringify(factResult, null, 2));
    console.log(`Latency: ${t5 - t4}ms`);

    // Test 3: retrieve_raw_evidence
    console.log('\n--- Test 3: retrieve_raw_evidence ---');
    const t6 = Date.now();
    const evResult = await client.callTool({
        name: 'retrieve_raw_evidence',
        arguments: { query: 'Where is QueryDispatcher initialized?' }
    });
    const t7 = Date.now();
    console.log(JSON.stringify(evResult, null, 2).substring(0, 500) + '... (truncated)');
    console.log(`Latency: ${t7 - t6}ms`);

    // Test 4: ask_repoguide
    console.log('\n--- Test 4: ask_repoguide ---');
    const t8 = Date.now();
    const askResult = await client.callTool({
        name: 'ask_repoguide',
        arguments: { question: 'What is the purpose of QueryDispatcher?' }
    });
    const t9 = Date.now();
    console.log(JSON.stringify(askResult, null, 2));
    console.log(`Latency: ${t9 - t8}ms`);

    await transport.close();
}

main().catch(console.error);
