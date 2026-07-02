import * as fs from 'fs';
import * as path from 'path';
import { TypeScriptSemanticProvider } from '../../indexing/semantic/providers/typescript/typeScriptSemanticProvider';
import { DefaultProgramProvider } from '../../indexing/semantic/providers/typescript/programProvider';
import { CanonicalFactAdapter } from '../../indexing/semantic/canonicalFactAdapter';
import { ShadowGraphBuilder } from '../../indexing/semantic/shadowGraphBuilder';
import { InMemoryShadowGraphStore } from '../../indexing/semantic/inMemoryShadowGraphStore';
import { CanonicalFactNormalizer } from '../../indexing/semantic/evaluation/canonicalFactNormalizer';
import { FactComparator } from '../../indexing/semantic/evaluation/factComparator';
import { SemanticRegressionDashboard } from '../../indexing/semantic/evaluation/semanticRegressionDashboard';
import { extractFacts } from '../../indexing/factExtractor';

function walkDir(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            if (!filePath.includes('node_modules') && !filePath.includes('.git') && !filePath.includes('dist') && !filePath.includes('out') && !filePath.includes('build')) {
                walkDir(filePath, fileList);
            }
        } else {
            if (filePath.endsWith('.ts') && !filePath.endsWith('.d.ts')) {
                fileList.push(filePath);
            }
        }
    }
    return fileList;
}

async function validateRepository(repoPath: string, repoName: string) {
    console.log(`\n========================================`);
    console.log(`Validating Repository: ${repoName}`);
    console.log(`Path: ${repoPath}`);
    console.log(`========================================\n`);

    const files = walkDir(repoPath);
    console.log(`Found ${files.length} TypeScript files.`);

    const programProvider = new DefaultProgramProvider();
    const tsProvider = new TypeScriptSemanticProvider(programProvider);
    const store = new InMemoryShadowGraphStore();
    const builder = new ShadowGraphBuilder(store);
    const normalizer = new CanonicalFactNormalizer();
    const comparator = new FactComparator();
    const dashboard = new SemanticRegressionDashboard();

    const startTime = Date.now();
    
    let successfulFiles = 0;
    let failedFiles = 0;
    
    let totalCanonicalFacts = 0;
    let totalObservations = 0;

    let allLegacyFacts: any[] = [];
    let allSemanticFacts: any[] = [];
    let allRejectedConstructs: any[] = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (i % 50 === 0 && i > 0) console.log(`Processed ${i}/${files.length} files...`);

        try {
            const content = fs.readFileSync(file, 'utf-8');

            // 1. Semantic Extraction
            const extractionResult = await tsProvider.extract(file, content);
            if (extractionResult.status === 'SUCCESS' || extractionResult.status === 'PARTIAL') {
                successfulFiles++;
            } else {
                failedFiles++;
                continue;
            }

            // 2. Adapter
            const { facts, observations } = CanonicalFactAdapter.translate(extractionResult);
            totalCanonicalFacts += facts.length;
            totalObservations += observations.length;
            allSemanticFacts.push(...facts);

            // 3. Builder
            builder.ingest('typescript-semantic-provider@1.1.0', facts, observations);

            // 4. Legacy Extraction (mock unit wrapper)
            const legacyFacts = extractFacts({
                id: file,
                filePath: file,
                content,
                startLine: 0,
                endLine: content.split('\n').length,
                role: 'general',
                symbol: 'file'
            } as any);
            allLegacyFacts.push(...legacyFacts);

        } catch (err: any) {
            console.error(`Error processing ${file}: ${err.message}`);
            failedFiles++;
        }
    }

    const extractionLatency = Date.now() - startTime;
    const memUsage = process.memoryUsage().heapUsed;

    // 5. Normalization
    const normResult = normalizer.normalize(allLegacyFacts);
    allRejectedConstructs = normResult.rejectedConstructs;

    // 6. Comparison
    const evalResult = comparator.compare(normResult.normalizedFacts, allSemanticFacts, allRejectedConstructs);

    // 7. Dashboard
    const dashboardOutput = dashboard.render(evalResult);

    console.log(`\n--- METRICS FOR ${repoName} ---`);
    console.log(`Total files indexed: ${files.length}`);
    console.log(`Successful files: ${successfulFiles}`);
    console.log(`Failed files: ${failedFiles}`);
    console.log(`Extraction latency: ${extractionLatency}ms`);
    console.log(`Peak memory usage: ${(memUsage / 1024 / 1024).toFixed(2)} MB`);
    console.log(`CanonicalFact count: ${totalCanonicalFacts}`);
    console.log(`FactObservation count: ${totalObservations}`);
    console.log(`Average observations per fact: ${totalCanonicalFacts > 0 ? (totalObservations / totalCanonicalFacts).toFixed(2) : 0}`);
    
    console.log(`\nLegacy facts: ${allLegacyFacts.length}`);
    console.log(`Normalized Canonical facts: ${normResult.normalizedFacts.length}`);
    console.log(`Rejected constructs: ${allRejectedConstructs.length}`);
    
    console.log(`\nIdentity drift count: ${evalResult.identityDrift.length}`);
    console.log(`Missing facts: ${evalResult.missing.length}`);
    console.log(`Unexpected facts: ${evalResult.unexpected.length}`);
    console.log(`Matching facts: ${evalResult.matching.length}`);
    
    fs.writeFileSync(`validation_${repoName}.log`, dashboardOutput);
    console.log(`Dashboard output saved to validation_${repoName}.log`);
}

async function run() {
    const repos: {name: string, path: string}[] = [];
    
    const cloneDir = path.resolve(__dirname, '../../../tmp_repos');
    if (fs.existsSync(cloneDir)) {
        const additionalRepos = fs.readdirSync(cloneDir);
        for (const repo of additionalRepos) {
            const repoPath = path.join(cloneDir, repo);
            if (fs.statSync(repoPath).isDirectory()) {
                repos.push({ name: repo, path: repoPath });
            }
        }
    }

    for (const repo of repos) {
        await validateRepository(repo.path, repo.name);
    }
}

run().catch(console.error);
