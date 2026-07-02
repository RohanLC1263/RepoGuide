import { QueryPipelineHarness } from './queryPipelineHarness';

async function main() {
    console.log("Initializing QueryPipelineHarness...");
    
    // Polyfill process.argv to enable compare mode
    process.argv.push('--mode', 'compare');
    
    const harness = new QueryPipelineHarness({
        workspaceRoot: 'c:/Projects/axios',
        repoguideDir: 'c:/Projects/axios/.repoguide',
        outputChannel: { appendLine: console.log },
        mode: 'compare'
    });
    
    await harness.init();
    
    const questions = [
        "What is Axios?",
        "Explain the request lifecycle.",
        "How do interceptors work?",
        "What is AxiosHeaders responsible for?",
        "Trace a request from API call to network dispatch."
    ];
    
    for (const q of questions) {
        console.log(`\n======================================================`);
        console.log(`QUESTION: ${q}`);
        console.log(`======================================================`);
        
        const result = await harness.runQuestion({
            id: `q-${q}`,
            question: q,
            type: 'explanation' as any,
            expectedAnswer: '',
            requiresLocations: false
        }, false);
        
        // Harness runs both because of `compare` mode and prints outputs
    }
}

main().catch(console.error);
