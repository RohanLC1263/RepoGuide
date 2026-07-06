/**
 * Investigation-only script (Pass 1, no production code modified): tests BM25 and vector
 * search directly against CraftConnect's real, existing index using rc-01's exact question
 * text, to determine whether the zero-hit result found dogfooding is a genuine vocabulary
 * gap or a mechanical bug (wrong index, stale/empty embeddings, tokenization mismatch).
 *
 * Usage: npm run compile && node out/evaluation/bm25VectorProbe.js
 */
import * as path from 'path';
import * as moduleObj from 'module';

function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = {
        workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k: string, f: unknown) => f }) },
        window: { createOutputChannel: () => ({ appendLine: console.log, show: () => undefined, dispose: () => undefined }) }
    };
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {return shim;}
        return originalRequire.apply(this, arguments as any);
    };
}
installVscodeShim();

import { Bm25Store } from '../store/bm25Store';
import { LanceStore } from '../store/lanceStore';
import { embedText } from '../ollama/embedder';
import { RepositoryContext } from '../context/repositoryContext';

function fakeContext(workspaceRoot: string): RepositoryContext {
    return {
        workspaceRoot,
        getConfig: <T,>(_key: string, defaultValue?: T) => defaultValue as T,
        asRelativePath: (p: string) => p,
        logger: {
            appendLine: (m: string) => console.log(m), debug: () => undefined, info: (m: string) => console.log(m), warn: (m: string) => console.log(m), error: (m: string) => console.log(m),
            stageStart: () => undefined, stageProgress: () => undefined, stageComplete: () => undefined, stageFailed: () => undefined,
            artifactWritten: () => undefined, queryLog: () => undefined, repairLog: () => undefined
        },
        notifyInfo: async () => undefined, notifyWarning: async () => undefined, notifyError: async () => undefined
    };
}

async function main(): Promise<void> {
    const workspaceRoot = process.env.CRAFTCONNECT_PATH ?? 'C:\\Users\\rohan\\Downloads\\CraftConnect';
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const context = fakeContext(workspaceRoot);

    const question = "What happens when a user uploads an image to start a new mission -- walk me through the full request path from HTTP endpoint to database record?";

    // --- BM25 ---
    const bm25Store = new Bm25Store(repoguideDir);
    await bm25Store.init();
    const chunkCount = await bm25Store.getChunkCount();
    console.log(`\nBM25 index document count: ${chunkCount}`);

    const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
    console.log(`Tokenized question: ${JSON.stringify(tokenize(question))}`);

    const fullResults = await bm25Store.search(question, 50);
    console.log(`BM25 search(full question) -> ${fullResults.length} results`);
    if (fullResults.length > 0) {
        console.log('Top 5:', JSON.stringify(fullResults.slice(0, 5).map(r => ({ file: r.filePath, score: r.score })), null, 2));
    }

    // Try individual high-signal words to isolate whether tokenization or index content is the issue
    for (const word of ['mission', 'upload', 'user', 'request', 'database', 'endpoint', 'record', 'image', 'start_mission', 'create_mission_record']) {
        const r = await bm25Store.search(word, 10);
        console.log(`BM25 search("${word}") -> ${r.length} results${r.length > 0 ? ' e.g. ' + r[0].filePath : ''}`);
    }

    // --- Vector ---
    console.log('\n--- Vector search ---');
    const lanceStore = new LanceStore(repoguideDir);
    await lanceStore.init();
    const totalChunks = await lanceStore.getChunkCount();
    console.log(`Lance chunk count: ${totalChunks}`);

    try {
        const vector = await embedText(context, question);
        console.log(`Embedding vector length: ${vector.length}, first 5 values: ${JSON.stringify(vector.slice(0, 5))}`);
        const results = await lanceStore.queryByVector(vector, 15);
        console.log(`Vector search -> ${results.length} results`);
        if (results.length > 0) {
            console.log('Top 5:', JSON.stringify(results.slice(0, 5).map((r: any) => ({ file: r.filePath, id: r.id })), null, 2));
        }

        // Compare against embedding a known-relevant real code snippet directly, to check
        // whether the embedding SPACE itself distinguishes relevant from irrelevant content,
        // or whether nothing comes back close to anything.
        const realSnippetVector = await embedText(context, 'async def execute_mission(mission_id, user_id, local_image_path, orchestrator): report = await orchestrator.run_mission(mission_input)');
        const resultsForRealSnippet = await lanceStore.queryByVector(realSnippetVector, 5);
        console.log(`Vector search using a REAL CODE SNIPPET as the query -> ${resultsForRealSnippet.length} results`);
        if (resultsForRealSnippet.length > 0) {
            console.log('Top:', JSON.stringify(resultsForRealSnippet.slice(0, 5).map((r: any) => ({ file: r.filePath, id: r.id })), null, 2));
        }
    } catch (error) {
        console.log('Vector search/embedding THREW:', error instanceof Error ? error.stack : String(error));
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});
