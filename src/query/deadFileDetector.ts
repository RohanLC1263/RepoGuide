import * as path from 'path';

/**
 * Shared "is this file's lack of importers expected?" logic, used by AnswerGate's
 * file-usage claim check.
 *
 * A NOTE ON WHAT IS DELIBERATELY ABSENT HERE. A retrieval-side down-rank of
 * "evidence from files nothing imports" was built and measured against CraftConnect,
 * then not shipped. It was aimed at a real, verified failure: asked why
 * `get_current_user` returns 401, the answer confidently explained Firebase JWT
 * verification (`jwt.decode`, `RS256`, `FIREBASE_PROJECT_ID`) -- all real code, lifted
 * from `app/core/community_engine.py`, a dead module -- while the live implementation
 * in `app/core/auth.py` calls `supabase.auth.get_user(token)`.
 *
 * The blocker was precision. "Zero inbound import edges" identified dead files at only
 * ~38% precision on backend Python and ~13% on frontend TS/TSX; corroborating with the
 * BM25 index lifted that to ~50%/~61%, still no better than a coin flip. The import
 * graph misses path-alias imports (`@/pages/...`), `__init__.py` re-exports and dynamic
 * imports, so live files (ingest_agent.py, qa_agent.py, rag_retriever_engine.py,
 * InterviewPage.tsx) were repeatedly judged dead. Suppressing their evidence on every
 * query would have been a worse regression than the misattribution being fixed.
 *
 * The misattribution is therefore addressed where it actually happens -- in synthesis,
 * via the file-attribution rule in evidencePrompt.ts -- which carries no
 * false-positive risk because it suppresses nothing. See ROADMAP.md for the numbers.
 */

/** Entry points are run, not imported -- no importers is expected, not evidence of death. */
export const ENTRY_POINT_BASENAMES = new Set([
    'main.py', 'app.py', '__main__.py', 'manage.py', 'wsgi.py', 'asgi.py',
    'index.ts', 'index.js', 'server.ts', 'server.js'
]);

/**
 * A file that DEFINES a router/middleware is mounted elsewhere via
 * include_router(...)/add_middleware(...) -- an edge the import graph does not model,
 * so it reports zero importers for genuinely live code. Keyed on the DEFINITION, not
 * on the presence of FastAPI()/add_middleware()/route decorators: a genuinely dead
 * standalone module (community_engine.py) contains all of those in its own unused
 * app, and keying on them would wrongly exempt exactly the file this exists to catch.
 */
export const FRAMEWORK_WIRING_DEFINITION_REGEXES: RegExp[] = [
    /\bAPIRouter\s*\(/,
    /\bclass\s+\w*Middleware\b/,
    /\bBlueprint\s*\(/,
    /\brouter\s*=\s*Router\s*\(/
];

/** Minimal graph surface needed here (structurally satisfied by ProgramGraphStore). */
export interface DeadFileGraphLookup {
    getDependents(symbolOrFile: string): { importers: { filePath: string }[] };
}

/**
 * True when a file having no inbound import edges is EXPECTED rather than suspicious:
 * application entry points (run, not imported) and files defining a router/middleware
 * that is mounted elsewhere through an edge the import graph does not capture.
 */
export function isEntryPointOrFrameworkWired(
    relativeFile: string,
    workspaceRoot: string | undefined,
    readFile: (absPath: string) => string | null
): boolean {
    const base = relativeFile.split(/[\\/]/).pop() ?? relativeFile;
    if (ENTRY_POINT_BASENAMES.has(base)) {
        return true;
    }
    if (!workspaceRoot) {
        return false;
    }
    try {
        const abs = path.isAbsolute(relativeFile) ? relativeFile : path.join(workspaceRoot, relativeFile);
        const src = readFile(abs);
        if (!src) {
            return false;
        }
        if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(src)) {
            return true;
        }
        return FRAMEWORK_WIRING_DEFINITION_REGEXES.some(re => re.test(src));
    } catch {
        return false;
    }
}
