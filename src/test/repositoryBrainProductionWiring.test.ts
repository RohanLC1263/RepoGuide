import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard against RepositoryBrainOrchestrator regressing back to "fully implemented and tested
 * but never wired into anything that runs" (see CLAUDE.md's Definition of Done #2 and the
 * documented history of src/intent, src/evolution, src/drift, src/causal being built this way).
 *
 * This is a plain text-based check, not an import-graph analysis: it reads the two real
 * production entry points and asserts each contains a genuine construction/scheduling call for
 * RepositoryBrainOrchestrator, not just an import. Cheap to keep honest if the wiring is ever
 * removed.
 */
describe('RepositoryBrain production wiring guard', () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
    const mcpServerSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'mcpServer.ts'), 'utf8');

    test('extension.ts imports and constructs RepositoryBrainOrchestrator', () => {
        expect(extensionSource).toMatch(/import\s*{[^}]*RepositoryBrainOrchestrator[^}]*}\s*from\s*['"]\.\/orchestrator\/repositoryBrainOrchestrator['"]/);
        expect(extensionSource).toMatch(/new RepositoryBrainOrchestrator\(/);
    });

    test('extension.ts schedules a real RepositoryBrain rebuild (not just constructs the orchestrator)', () => {
        expect(extensionSource).toMatch(/scheduleRepositoryBrainRebuild\(/);
        expect(extensionSource).toMatch(/orchestrator\.runFullRebuild\(\)/);
    });

    test('extension.ts registers RepositoryBrainProvider in the canonical RetrievalOrchestrator', () => {
        expect(extensionSource).toMatch(/new RepositoryBrainProvider\(/);
        expect(extensionSource).toMatch(/repositoryBrainProvider/);
    });

    test('mcpServer.ts imports and constructs RepositoryBrainOrchestrator', () => {
        expect(mcpServerSource).toMatch(/import\s*{[^}]*RepositoryBrainOrchestrator[^}]*}\s*from\s*['"]\.\.\/orchestrator\/repositoryBrainOrchestrator\.js['"]/);
        expect(mcpServerSource).toMatch(/new RepositoryBrainOrchestrator\(/);
        expect(mcpServerSource).toMatch(/runFullRebuild\(\)/);
    });

    test('mcpServer.ts registers RepositoryBrainProvider in the canonical RetrievalOrchestrator', () => {
        expect(mcpServerSource).toMatch(/new RepositoryBrainProvider\(/);
    });

    test('the superseded RepositoryBrainEvidenceStore is gone, not left running in parallel', () => {
        const evidenceStorePath = path.join(__dirname, '..', 'query', 'repositoryBrainEvidenceStore.ts');
        expect(fs.existsSync(evidenceStorePath)).toBe(false);
        expect(extensionSource).not.toMatch(/RepositoryBrainEvidenceStore/);
        expect(mcpServerSource).not.toMatch(/RepositoryBrainEvidenceStore/);
    });
});
