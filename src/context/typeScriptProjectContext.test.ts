import * as ts from 'typescript';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { TypeScriptProjectContext } from './typeScriptProjectContext';

describe('TypeScriptProjectContext', () => {
    let context: TypeScriptProjectContext;
    const workspaceRoot = process.cwd();

    beforeEach(() => {
        context = new TypeScriptProjectContext(workspaceRoot);
    });

    afterEach(() => {
        context.dispose();
    });

    it('should initialize and return a ts.Program', () => {
        const program = context.getProgram();
        expect(program).toBeDefined();
        expect(program.getSourceFiles().length).toBeGreaterThan(0);
    });

    it('should return a ts.TypeChecker', () => {
        const checker = context.getTypeChecker();
        expect(checker).toBeDefined();
        expect(typeof checker.getSymbolAtLocation).toBe('function');
    });

    it('should execute semantic query safely', () => {
        const result = context.executeSemanticQuery((checker) => {
            return checker ? true : false;
        });
        expect(result).toBe(true);
    });

    it('should rebuild lazily and batch multiple invalidations', () => {
        const createProgramSpy = jest.spyOn(ts, 'createProgram');
        
        // Initial build
        context.getProgram();
        expect(createProgramSpy).toHaveBeenCalledTimes(1);
        createProgramSpy.mockClear();

        const dummyFile1 = path.resolve(workspaceRoot, 'package.json');
        const dummyFile2 = path.resolve(workspaceRoot, 'tsconfig.json');

        // Multiple invalidations
        context.invalidateFile(dummyFile1);
        context.invalidateFile(dummyFile2);

        // Should be lazy, not rebuilt yet
        expect(createProgramSpy).toHaveBeenCalledTimes(0);

        // Now trigger rebuild
        context.getProgram();

        // Should only have built once despite two invalidations
        expect(createProgramSpy).toHaveBeenCalledTimes(1);

        createProgramSpy.mockRestore();
    });

    it('should reuse SourceFile cache across rebuilds', () => {
        // We'll test this by accessing getSourceFile from the host directly,
        // but since host is private, we'll spy on the internal originalGetSourceFile indirectly,
        // or easier: spy on ts.sys.readFile which TS uses under the hood to load files if not cached.
        const readFileSpy = jest.spyOn(ts.sys, 'readFile');
        
        // First build - reads all files
        context.getProgram();
        const readsFirstBuild = readFileSpy.mock.calls.length;
        expect(readsFirstBuild).toBeGreaterThan(0);
        readFileSpy.mockClear();

        // Invalidate one specific file
        const fileToInvalidate = path.resolve(workspaceRoot, 'package.json').replace(/\\/g, '/');
        context.invalidateFile(fileToInvalidate);

        // Rebuild program
        context.getProgram();

        // It should only have read the invalidated file (or very few files), not the whole project again.
        const readsSecondBuild = readFileSpy.mock.calls.length;
        
        // Because of the cache, the second build should read drastically fewer files.
        // It might read 0 if the file wasn't part of the TS program anyway, but we just want to ensure it's less.
        expect(readsSecondBuild).toBeLessThan(readsFirstBuild);

        readFileSpy.mockRestore();
    });
});
