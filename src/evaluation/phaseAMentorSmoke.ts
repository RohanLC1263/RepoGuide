import * as assert from 'assert';
import { buildAnswerMetadata, buildExplainSelectionMetadata, isOnboardingQuestion } from '../query/answerMetadata';
import { FusedChunk } from '../query/hybridRetrievalFusion';
import { FileAnnotation } from '../comprehension/fileAnnotationEngine';
import { CommunitySummary } from '../comprehension/communityClustering';
import { CodeChunk } from '../store/storeTypes';

function chunk(filePath: string, startLine: number, endLine: number, text: string): CodeChunk {
    return {
        id: `${filePath}:${startLine}`,
        filePath,
        language: 'javascript',
        startLine,
        endLine,
        text,
        vector: [],
        hash: 'hash'
    };
}

const retrieved: FusedChunk[] = [
    { chunk: chunk('lib/core/Axios.js', 20, 80, 'class Axios { request(configOrUrl, config) {} }'), score: 1, rank: 1 },
    { chunk: chunk('lib/core/dispatchRequest.js', 10, 70, 'export default function dispatchRequest(config) {}'), score: 0.8, rank: 2 }
];

const annotations: FileAnnotation[] = [
    {
        file: 'lib/core/Axios.js',
        hash: 'hash1',
        generated_at: new Date().toISOString(),
        confidence: 'high',
        what: 'Defines the central Axios class and request orchestration methods.',
        role: 'service',
        key_symbols: ['Axios', 'request'],
        depends_on: ['lib/core/dispatchRequest.js'],
        signals: ['async_pattern']
    },
    {
        file: 'index.js',
        hash: 'hash2',
        generated_at: new Date().toISOString(),
        confidence: 'high',
        what: 'Exports the public Axios API entry point.',
        role: 'entry_point',
        key_symbols: ['axios'],
        depends_on: ['lib/axios.js'],
        signals: []
    }
];

const communities: CommunitySummary[] = [
    {
        id: 'core',
        name: 'core',
        central_file: 'lib/core/Axios.js',
        files: ['lib/core/Axios.js', 'lib/core/dispatchRequest.js'],
        summary: 'Core request orchestration and dispatch behavior.',
        generated_at: new Date().toISOString()
    }
];

const metadata = buildAnswerMetadata({
    question: 'what is this project?',
    chunks: retrieved,
    annotations,
    communities,
    projectUnderstanding: {
        what_it_does: 'Axios is a promise-based HTTP client for browser and Node.js environments.'
    } as any
});

assert.equal(isOnboardingQuestion('what is this project?'), true);
assert.equal(metadata.mode, 'onboarding');
assert.ok(metadata.onboarding, 'onboarding metadata should be present');
assert.equal(metadata.onboarding?.what_this_project_does, 'Axios is a promise-based HTTP client for browser and Node.js environments.');
assert.ok(metadata.onboarding?.main_modules.some(module => module.name === 'core'));
assert.ok(metadata.onboarding?.recommended_starting_files.some(ref => ref.file === 'index.js'));
assert.ok(metadata.file_references.some(ref => ref.file === 'lib/core/Axios.js' && ref.source === 'retrieval'));

const explainMetadata = buildExplainSelectionMetadata({
    question: 'Explain selected code in lib/core/Axios.js',
    selectedFile: 'lib/core/Axios.js',
    startLine: 20,
    endLine: 80,
    anchorChunks: [retrieved[0].chunk],
    relatedChunks: [retrieved[1].chunk],
    selectedSymbols: [{
        name: 'Axios',
        filePath: 'lib/core/Axios.js',
        startLine: 20,
        endLine: 80,
        kind: 'class'
    }],
    annotations,
    communities
});

assert.ok(explainMetadata.file_references.some(ref =>
    ref.file === 'lib/core/Axios.js' &&
    ref.symbol === 'Axios' &&
    ref.source === 'symbol_index'
));
assert.ok(explainMetadata.file_references.some(ref => ref.file === 'lib/core/dispatchRequest.js'));

console.log('Phase A mentor backend smoke PASS');
console.log(JSON.stringify({
    onboarding: metadata.onboarding,
    file_references: metadata.file_references.slice(0, 4),
    explain_file_references: explainMetadata.file_references.slice(0, 4)
}, null, 2));
