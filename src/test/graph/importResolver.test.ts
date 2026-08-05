import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImportStatement, resolveImportToFiles } from '../../graph/importResolver';

/**
 * Pins module-path resolution for import edges. The behaviour replaced here scanned file nodes
 * in insertion order and linked to the first whose BASENAME occurred anywhere in the import
 * text -- which could never reach a package file ("__init__" appears in no import statement)
 * and produced wrong edges for short basenames.
 */

const FILES = new Set([
    'app/agents/__init__.py',
    'app/agents/base_agent.py',
    'app/agents/mission_orchestrator.py',
    'app/llm_backends/__init__.py',
    'app/core/auth.py',
    'app/routers/auth.py',
    'src/components/index.ts',
    'src/components/Button.tsx',
    'src/util/format.ts'
]);
const exists = (p: string): boolean => FILES.has(p);

test('parse: absolute python from-import', () => {
    const p = parseImportStatement('from app.agents.base_agent import BaseAgent');
    assert.equal(p?.module, 'app.agents.base_agent');
    assert.equal(p?.relativeLevel, 0);
    assert.deepEqual(p?.names, ['BaseAgent']);
});

test('parse: relative python import records its dot level', () => {
    assert.equal(parseImportStatement('from . import auth')?.relativeLevel, 1);
    assert.equal(parseImportStatement('from ..core import auth')?.relativeLevel, 2);
});

test('parse: aliases and parenthesised name lists', () => {
    const p = parseImportStatement('from app.agents import (BaseAgent as B, MissionOrchestratorAgent)');
    assert.deepEqual(p?.names, ['BaseAgent', 'MissionOrchestratorAgent']);
});

test('resolve: package import reaches __init__.py (the case the old matcher could never hit)', () => {
    const r = resolveImportToFiles('from app.agents import MissionOrchestratorAgent', 'app/main.py', exists);
    assert.ok(r.includes('app/agents/__init__.py'), `expected package file, got ${JSON.stringify(r)}`);
});

test('resolve: submodule import reaches the module file, not the package', () => {
    const r = resolveImportToFiles('from app.agents.base_agent import BaseAgent', 'app/main.py', exists);
    assert.deepEqual(r, ['app/agents/base_agent.py']);
});

test('resolve: "from pkg import submodule" also reaches the submodule file', () => {
    const r = resolveImportToFiles('from app.agents import base_agent', 'app/main.py', exists);
    assert.ok(r.includes('app/agents/__init__.py'));
    assert.ok(r.includes('app/agents/base_agent.py'));
});

test('resolve: relative import is anchored to the IMPORTING file\'s directory', () => {
    // The old substring matcher paired this with app/core/auth.py regardless of source dir.
    const fromRouters = resolveImportToFiles('from . import auth', 'app/routers/conversation.py', exists);
    assert.deepEqual(fromRouters, ['app/routers/auth.py']);
    const fromCore = resolveImportToFiles('from . import auth', 'app/core/community_engine.py', exists);
    assert.deepEqual(fromCore, ['app/core/auth.py']);
});

test('resolve: third-party and stdlib imports produce NO edge', () => {
    assert.deepEqual(resolveImportToFiles('import os', 'app/main.py', exists), []);
    assert.deepEqual(resolveImportToFiles('from fastapi import FastAPI', 'app/main.py', exists), []);
    assert.deepEqual(resolveImportToFiles("import React from 'react'", 'src/App.tsx', exists), []);
});

test('resolve: TS/JS relative specifier, including directory -> index', () => {
    assert.deepEqual(
        resolveImportToFiles("import { Button } from './Button'", 'src/components/App.tsx', exists),
        ['src/components/Button.tsx']
    );
    assert.deepEqual(
        resolveImportToFiles("import x from './components'", 'src/App.tsx', exists),
        ['src/components/index.ts']
    );
    assert.deepEqual(
        resolveImportToFiles("import { fmt } from '../util/format'", 'src/components/App.tsx', exists),
        ['src/util/format.ts']
    );
});

test('resolve: an unknown module never invents an edge', () => {
    assert.deepEqual(resolveImportToFiles('from app.nonexistent import Thing', 'app/main.py', exists), []);
});
