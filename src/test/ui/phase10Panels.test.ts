import { describe, test, expect, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildOrientationHtml, PanelDeps } from '../../ui/phase10Panels';

const PANEL_OPENING_COMMANDS = [
    'repoguide.indexHealth',
    'repoguide.memoryExplorerPanel',
    'repoguide.docreport',
    'repoguide.showDailyBrief',
    'repoguide.notesPanel',
    'repoguide.planTrackerPanel',
    'repoguide.openChat',
    'repoguide.investigationPanel',
    'repoguide.whatDoesThisFileAffect'
];

function makeDeps(): PanelDeps {
    return {
        context: {} as any,
        repoguideDir: '/nonexistent/.repoguide',
        workspaceRoot: '/nonexistent',
        investigationEngine: {} as any,
        planAnalyzer: {} as any,
        getIndexedFileCount: async () => 0
    };
}

describe('Orientation panel as the single entry-point dashboard', () => {
    test('surfaces a launcher to every real panel-opening capability, not just its own content', async () => {
        const html = await buildOrientationHtml(makeDeps());

        for (const command of PANEL_OPENING_COMMANDS) {
            expect(html).toContain(`runCommand('${command}')`);
        }
    });

    test('capabilities launcher is present even before the workspace has been indexed', async () => {
        // buildOrientationHtml's "not indexed yet" early-return path (repoguideDir
        // doesn't exist) must still include the launcher -- a first-time user with
        // no index yet is exactly who most needs to discover the other panels.
        const html = await buildOrientationHtml(makeDeps());
        expect(html).toContain('Run indexing first');
        expect(html).toContain('Capabilities');
        expect(html).toContain(`runCommand('repoguide.indexHealth')`);
    });
});

// --- 2026-07-10 fixes: dead-code-cited Key Modules, false-promise synthesis
// empty-state, and an entry-points fallback that trusted an LLM-authored role
// field and rendered dead/hallucinated links. See the corresponding
// investigation for how each was confirmed on real CraftConnect data. ---

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop()!;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeTempWorkspace(): { workspaceRoot: string; repoguideDir: string } {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-orientation-ws-'));
    tempDirs.push(workspaceRoot);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    fs.mkdirSync(repoguideDir, { recursive: true });
    return { workspaceRoot, repoguideDir };
}

function writeRealFile(workspaceRoot: string, relPath: string): void {
    const full = path.join(workspaceRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// fixture file\n', 'utf8');
}

/** Writes a real annotation JSON to <repoguideDir>/annotations/, matching the
 * exact on-disk shape FileAnnotationEngine reads (see fileAnnotationEngine.ts's
 * FileAnnotation interface) -- not a mock of the engine, the real file format. */
function writeAnnotation(repoguideDir: string, opts: { file: string; role: string; key_symbols?: string[] }): void {
    const annotationsDir = path.join(repoguideDir, 'annotations');
    fs.mkdirSync(annotationsDir, { recursive: true });
    const hash = opts.file.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Math.random().toString(36).slice(2, 8);
    const annotation = {
        file: opts.file,
        hash,
        generated_at: new Date().toISOString(),
        confidence: 'high',
        what: 'fixture annotation',
        role: opts.role,
        key_symbols: opts.key_symbols ?? [],
        depends_on: [],
        signals: []
    };
    fs.writeFileSync(path.join(annotationsDir, `${hash}.json`), JSON.stringify(annotation, null, 2), 'utf8');
}

function makeRealDeps(workspaceRoot: string, repoguideDir: string): PanelDeps {
    return {
        context: {} as any,
        repoguideDir,
        workspaceRoot,
        investigationEngine: {} as any,
        planAnalyzer: {} as any,
        getIndexedFileCount: async () => 0
    };
}

describe('Orientation panel: Key Modules removal (dead code was cited as live architecture)', () => {
    test('Key Modules section is absent from rendered output even when real community-clustering data exists', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        // Real shape from CraftConnect's actual community_summaries.json -- a
        // community whose name/summary are entirely a confirmed-dead file's own
        // symbols (color_helper.py, zero references anywhere in app/).
        fs.writeFileSync(path.join(repoguideDir, 'community_summaries.json'), JSON.stringify({
            communities: [{
                name: 'Color Palette Manager',
                summary: 'Manages and provides color palette operations through the ColorPalette class and generate_palette function.',
                files: ['app/helpers/color_helper.py']
            }]
        }), 'utf8');

        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        expect(html).not.toContain('Key Modules');
        expect(html).not.toContain('Color Palette Manager');
        expect(html).not.toContain('generate_palette');
    });

    test('Key Modules section is absent even when no community data exists at all (not just hidden behind an empty-state check)', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));
        expect(html).not.toContain('Key Modules');
    });
});

describe('Orientation panel: project-synthesis empty state', () => {
    test('states plainly that synthesis is not yet available, not that it simply has not run yet', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        expect(html).toContain('Project synthesis: not yet available.');
        expect(html).not.toContain('No project synthesis found yet');
    });
});

describe('Orientation panel: Entry Points fallback hardening', () => {
    test('excludes a test-directory fixture file even though its annotation claims role: entry_point', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        writeRealFile(workspaceRoot, 'tests/demo_runner.py');
        writeAnnotation(repoguideDir, { file: 'tests/demo_runner.py', role: 'entry_point', key_symbols: ['run_demo'] });

        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        expect(html).not.toContain('demo_runner.py');
    });

    test('excludes a legacy-directory fixture file even though its annotation claims role: entry_point', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        writeRealFile(workspaceRoot, 'legacy/scripts/run_demo_mission.py');
        writeAnnotation(repoguideDir, { file: 'legacy/scripts/run_demo_mission.py', role: 'entry_point', key_symbols: ['run_demo'] });

        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        expect(html).not.toContain('run_demo_mission.py');
    });

    test('a genuine implementation-role entry point is included, with parent-directory context in the label', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        writeRealFile(workspaceRoot, 'app/main.py');
        writeAnnotation(repoguideDir, { file: 'app/main.py', role: 'entry_point', key_symbols: ['create_app', 'lifespan'] });

        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        // Assert on the rendered LABEL text specifically (the ">...<" content
        // between the button's tags), not just a loose substring match --
        // ep.file (used inside the onclick(...) JS call) is always the full
        // path regardless of label format, so a bare `toContain('app/main.py')`
        // would pass even with the old basename-only label and prove nothing.
        // The real investigation finding was that "index.ts (LoginScreen)" hid
        // the fact it was tutorial/screens/index.ts, a barrel file, not a
        // genuine entry point -- parent-directory context in the LABEL is what
        // makes a future misclassification like that visible instead of hidden.
        expect(html).toContain('>app/main.py (create_app)<');
    });

    test('a nonexistent (hallucinated-shape) annotation path is filtered out before rendering, never a dead link', async () => {
        const { workspaceRoot, repoguideDir } = makeTempWorkspace();
        // Matches workspacePathResolver.ts's own corrupted-path example shape --
        // the real annotation found in the investigation, confirmed to not exist
        // on disk. Deliberately NOT created on disk here either.
        const hallucinatedPath = 'app-header-component for CraftConnect/app/layout.tsx';
        writeAnnotation(repoguideDir, { file: hallucinatedPath, role: 'entry_point', key_symbols: ['RootLayout'] });
        // A real, existing entry point too, so the test proves selective
        // filtering, not an empty result masking the bug.
        writeRealFile(workspaceRoot, 'app/main.py');
        writeAnnotation(repoguideDir, { file: 'app/main.py', role: 'entry_point', key_symbols: ['app'] });

        const html = await buildOrientationHtml(makeRealDeps(workspaceRoot, repoguideDir));

        expect(html).not.toContain('layout.tsx');
        expect(html).not.toContain('RootLayout');
        expect(html).not.toContain(hallucinatedPath);
        expect(html).toContain('app/main.py');
    });
});
