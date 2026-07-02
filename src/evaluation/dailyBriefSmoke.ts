import * as fs from 'fs';
import * as path from 'path';

// Mock vscode module before anything else is imported
const mockVscode = {
    EventEmitter: class {
        event = {};
        fire() {}
    }
};
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
    if (id === 'vscode') return mockVscode;
    return originalRequire.apply(this, arguments);
};

import { DailyBriefService } from '../brief/dailyBriefService';
import { NotesManager, DeveloperNote } from '../notes/notesManager';
import { StalenessRegistry } from '../comprehension/stalenessRegistry';
import { LanceStore } from '../store/lanceStore';
import * as crypto from 'crypto';

export async function runDailyBriefSmokeTest(repoguideDir: string, workspaceRoot: string): Promise<boolean> {
    console.log('[Daily Brief Smoke] Starting smoke test...');
    let passed = true;

    const notesManager = new NotesManager(repoguideDir, workspaceRoot);
    const stalenessRegistry = new StalenessRegistry(path.join(repoguideDir, 'understanding'));
    
    // Mock store for fallback tests
    const mockStore = {
        getAllFilePaths: async () => ['mock_file_1.ts', 'mock_file_2.ts', 'src/extension.ts']
    } as unknown as LanceStore;

    const briefService = new DailyBriefService(workspaceRoot, repoguideDir, notesManager, stalenessRegistry, mockStore);

    const sessionDir = path.join(repoguideDir, 'session');
    const sessionFile = path.join(sessionDir, 'last_session.json');
    if (fs.existsSync(sessionFile)) {
        fs.unlinkSync(sessionFile);
    }

    try {
        // Test 1: First session
        console.log('[Daily Brief Smoke] Test 1: First Session');
        const firstBrief = await briefService.generateBrief();
        if (firstBrief.data_sources[0] !== 'first_session') {
            console.error('[Daily Brief Smoke] Expected first_session data source');
            passed = false;
        }
        if (!fs.existsSync(sessionFile)) {
            console.error('[Daily Brief Smoke] Session file was not created');
            passed = false;
        }

        // Setup mock data for Test 2
        console.log('[Daily Brief Smoke] Setup mock data for Test 2');
        const testFile = 'src/extension.ts';
        
        // Add a mock note
        const testNote: DeveloperNote = {
            id: `note_smoke_${Date.now()}`,
            target_file: testFile,
            title: 'Smoke Test Note',
            content: 'This note is for smoke testing.',
            tags: ['smoke'],
            source: 'manual',
            confidence: 'user_confirmed',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await notesManager.saveNote(testNote);

        // Add a mock stale annotation
        stalenessRegistry.markDirty(['mock_artifact_1'], testFile, 'Smoke test reason');

        // Rewind session time to force detection of all changes
        const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(sessionFile, JSON.stringify({ last_session_time: oldTime }));

        // Test 2: Second session (with changes)
        console.log('[Daily Brief Smoke] Test 2: Second Session');
        const secondBrief = await briefService.generateBrief();
        
        if (secondBrief.changed_files.length === 0) {
            console.error('[Daily Brief Smoke] Expected changed files');
            passed = false;
        }

        const hasExtensionTs = secondBrief.changed_files.some(f => f.file.includes('extension.ts'));
        if (!hasExtensionTs) {
            console.error('[Daily Brief Smoke] Expected extension.ts to be in changed files');
            passed = false;
        }

        if (secondBrief.stale_annotations.length === 0 || secondBrief.stale_annotations[0].file !== testFile) {
            console.error('[Daily Brief Smoke] Expected stale annotation for test file');
            passed = false;
        }

        if (secondBrief.related_notes.length === 0 || secondBrief.related_notes[0].note_id !== testNote.id) {
            console.error('[Daily Brief Smoke] Expected related note for test file');
            passed = false;
        }
        
        if (secondBrief.data_sources.includes('first_session')) {
             console.error('[Daily Brief Smoke] Data sources should not include first_session');
             passed = false;
        }

        console.log('[Daily Brief Smoke] Tests completed. Passed:', passed);

    } finally {
        // Cleanup
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
        }
        const notes = await notesManager.loadNotes();
        const testNote = notes.find(n => n.title === 'Smoke Test Note');
        if (testNote) {
            await notesManager.deleteNote(testNote.id);
        }
        stalenessRegistry.clearDirty('mock_artifact_1');
    }

    return passed;
}

// Allow running directly
if (require.main === module) {
    const workspaceRoot = process.cwd();
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    runDailyBriefSmokeTest(repoguideDir, workspaceRoot).then(passed => {
        process.exit(passed ? 0 : 1);
    });
}
