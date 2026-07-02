import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatPipeline } from '../query/hybridQueryPipeline';

suite("Investigation UI Test", function () {
    this.timeout(240000); // 4 minutes

    test("Query C through extension host", async () => {
        const ext = vscode.extensions.getExtension('repoguides-publisher.repoguide');
        assert.ok(ext, 'Extension not found');

        const api = await ext.activate();
        assert.ok(api && api.queryPipeline, 'API or queryPipeline not exported');

        const pipeline = api.queryPipeline as ChatPipeline;
        const abortController = new AbortController();
        const query = "How does the LLM Router handle text generation specifically for translation?";

        console.log(`\n\n=== STARTING QUERY IN EXTENSION HOST ===`);
        console.log(`Query: ${query}`);

        let fullResponse = "";
        try {
            for await (const chunk of pipeline.query(query, abortController.signal, () => {})) {
                fullResponse += chunk;
            }
            console.log(`\n=== SUCCESS ===\nReceived length: ${fullResponse.length}\nSnippet: ${fullResponse.slice(0, 100)}...`);
        } catch (error: any) {
            console.error(`\n=== FAILURE DETECTED ===`);
            console.error(`Name: ${error?.name}`);
            console.error(`Message: ${error?.message}`);
            console.error(`Cause: ${error?.cause}`);
            console.error(`Stack: ${error?.stack}`);
            assert.fail(error);
        }
    });
});
