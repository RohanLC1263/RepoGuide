import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, PythonProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { PythonNameResolver } from './nameResolver';
import { PythonModulePathResolver } from './moduleResolver';
import { effectiveParent, findEnclosingDefinition } from '../astHelpers';

export interface PythonRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type PythonResolveResult =
    | { type: 'descriptor'; descriptor: PythonRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

/**
 * Per-node relationship rule engine, scoped per the plan's honest-tier design:
 * DECLARES/IMPORTS/EXTENDS are structural (high confidence); CALLS/INSTANTIATES
 * are same-file/same-module name resolution only, reusing the exact
 * uppercase-callee heuristic already live in symbolExtractor.ts/factExtractor.ts;
 * REFERENCES is excluded entirely (see plan/report for why).
 */
export class PythonRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: PythonProgramHandle,
        nameResolver: PythonNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): PythonResolveResult[] {
        switch (node.type) {
            case 'class_definition':
            case 'function_definition':
                return this.resolveDeclares(node, handle, moduleDescriptor);
            case 'import_statement':
            case 'import_from_statement':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'call':
                return this.resolveCallOrInstantiate(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /** class_definition's superclasses field -- called once per class, not routed through the generic switch above (see declarationVisitor.ts). */
    public static resolveExtends(classNode: Parser.SyntaxNode, handle: PythonProgramHandle, nameResolver: PythonNameResolver): PythonResolveResult[] {
        const superclasses = classNode.childForFieldName('superclasses');
        if (!superclasses) {
            return [];
        }
        const className = classNode.childForFieldName('name')?.text;
        if (!className) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(classNode, className, 'class', handle);
        const results: PythonResolveResult[] = [];
        const loc = { filePath: handle.filePath, startLine: classNode.startPosition.row + 1, endLine: classNode.endPosition.row + 1 };

        for (const child of superclasses.namedChildren) {
            if (child.type !== 'identifier') {
                continue; // skips keyword_argument (e.g. metaclass=X) and dotted/attribute bases (out of scope for v1)
            }
            const baseName = child.text;
            const baseNode = nameResolver.resolveModuleLevel(baseName);
            if (baseNode && baseNode.type === 'class_definition') {
                const targetDescriptor = IdentityDescriptorBuilder.build(baseNode, baseName, 'class', handle);
                results.push({
                    type: 'descriptor',
                    descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'EXTENDS', location: loc }
                });
            } else {
                results.push({ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Base class', `Base class "${baseName}" is not declared in this file (likely imported) -- cross-module base-class resolution is out of scope.`) });
            }
        }
        return results;
    }

    private static resolveDeclares(node: Parser.SyntaxNode, handle: PythonProgramHandle, moduleDescriptor: IdentityDescriptor): PythonResolveResult[] {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const isMethod = node.type === 'function_definition' && effectiveParent(node)?.type === 'block' && effectiveParent(node)?.parent?.type === 'class_definition';
        const kind = node.type === 'class_definition' ? 'class' : isMethod ? 'method' : 'function';
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, kind, handle);
        const loc = { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };

        const enclosing = findEnclosingDefinition(node);
        let sourceDescriptor: IdentityDescriptor;
        if (enclosing && enclosing.type === 'class_definition') {
            const enclosingName = enclosing.childForFieldName('name')?.text;
            if (!enclosingName) {
                return [];
            }
            sourceDescriptor = IdentityDescriptorBuilder.build(enclosing, enclosingName, 'class', handle);
        } else {
            // Top-level declaration -- DECLARES from the synthetic module entity.
            sourceDescriptor = moduleDescriptor;
        }

        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveImports(node: Parser.SyntaxNode, handle: PythonProgramHandle, moduleDescriptor: IdentityDescriptor): PythonResolveResult[] {
        const loc = { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
        const results: PythonResolveResult[] = [];

        const emitTarget = (resolvedFilePath: string | null, describedSource: string) => {
            if (!resolvedFilePath) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Import', `Could not resolve import target "${describedSource}" to a file in this workspace.`) });
                return;
            }
            const { modulePath } = PythonModulePathResolver.resolveModulePath(resolvedFilePath, handle.workspaceRoot);
            const targetDescriptor: IdentityDescriptor = {
                package: 'workspace',
                logicalNamespace: modulePath,
                qualifiedName: '',
                symbolKind: 'module',
                signatureHash: 'v1|0000000000000000',
                identityOrigin: 'Repository',
                identityAuthority: 'parser'
            };
            results.push({ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'IMPORTS', location: loc } });
        };

        if (node.type === 'import_statement') {
            for (const child of node.namedChildren) {
                if (child.type === 'dotted_name') {
                    const dotted = child.text;
                    const resolved = PythonModulePathResolver.resolveAbsoluteImport(handle.filePath, handle.workspaceRoot, dotted);
                    emitTarget(resolved, dotted);
                } else if (child.type === 'aliased_import') {
                    const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
                    const dotted = dottedName?.text ?? child.text;
                    const resolved = PythonModulePathResolver.resolveAbsoluteImport(handle.filePath, handle.workspaceRoot, dotted);
                    emitTarget(resolved, dotted);
                }
            }
            return results;
        }

        // import_from_statement
        const relative = node.namedChildren.find(c => c.type === 'relative_import');
        if (relative) {
            const prefix = relative.namedChildren.find(c => c.type === 'import_prefix');
            const dotCount = prefix ? prefix.children.filter(c => c.type === '.').length : 1;
            const trailing = relative.namedChildren.find(c => c.type === 'dotted_name');
            const resolved = PythonModulePathResolver.resolveRelativeImport(handle.filePath, dotCount, trailing?.text ?? null);
            emitTarget(resolved, relative.text);
            return results;
        }

        const absoluteModule = node.namedChildren.find(c => c.type === 'dotted_name');
        if (absoluteModule) {
            const resolved = PythonModulePathResolver.resolveAbsoluteImport(handle.filePath, handle.workspaceRoot, absoluteModule.text);
            emitTarget(resolved, absoluteModule.text);
        }
        return results;
    }

    private static resolveCallOrInstantiate(node: Parser.SyntaxNode, handle: PythonProgramHandle, nameResolver: PythonNameResolver): PythonResolveResult[] {
        const calleeNode = node.childForFieldName('function');
        if (!calleeNode) {
            return [];
        }

        let calleeName: string | null = null;
        let targetNode: Parser.SyntaxNode | null = null;

        if (calleeNode.type === 'identifier') {
            calleeName = calleeNode.text;
            targetNode = nameResolver.resolveModuleLevel(calleeName);
        } else if (calleeNode.type === 'attribute') {
            const object = calleeNode.namedChildren[0];
            const attr = calleeNode.childForFieldName('attribute');
            if (object && (object.text === 'self' || object.text === 'cls') && attr) {
                calleeName = attr.text;
                targetNode = nameResolver.resolveMethodOnEnclosingClass(node, calleeName);
            }
        }

        if (!calleeName) {
            return []; // e.g. a call through a subscript/complex expression -- not attempted
        }

        // Same uppercase-first-letter heuristic already live in symbolExtractor.ts/factExtractor.ts.
        const isInstantiation = calleeName.length > 0 && calleeName[0] >= 'A' && calleeName[0] <= 'Z';
        const loc = { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };

        const enclosingDef = findEnclosingDefinition(node);
        if (!enclosingDef) {
            return []; // module-level top code calling something -- no enclosing function/method to be the source
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = enclosingDef.type === 'class_definition' ? 'class' : this.classifyFunctionKind(enclosingDef);
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, enclosingKind, handle);

        if (!targetNode) {
            if (isInstantiation) {
                // Only flag unresolved *instantiation-shaped* calls -- flagging every
                // unresolved lowercase call (builtins, external functions, chained
                // calls) would make KnownUnknowns noise rather than signal.
                return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Unresolved Instantiation', `Callee "${calleeName}" starts with an uppercase letter (looks like a class instantiation) but isn't declared in this file.`) }];
            }
            return [];
        }

        const targetKind = targetNode.type === 'class_definition' ? 'class' : this.classifyFunctionKind(targetNode);
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, calleeName, targetKind, handle);
        return [{
            type: 'descriptor',
            descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: isInstantiation ? 'INSTANTIATES' : 'CALLS', location: loc }
        }];
    }

    private static classifyFunctionKind(node: Parser.SyntaxNode): 'function' | 'method' {
        const parent = effectiveParent(node);
        return parent?.type === 'block' && parent.parent?.type === 'class_definition' ? 'method' : 'function';
    }

    private static knownUnknown(source: IdentityDescriptor, location: { filePath: string; startLine: number; endLine: number }, construct: string, reason: string): KnownUnknown {
        return {
            id: `ku-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            source: {
                package: source.package,
                logicalNamespace: source.logicalNamespace,
                kind: source.symbolKind,
                qualifiedName: source.qualifiedName,
                signatureHash: source.signatureHash,
                identityOrigin: source.identityOrigin,
                identityAuthority: source.identityAuthority
            },
            sourceLocation: location,
            unsupportedConstruct: construct,
            reason,
            evidence: [],
            recommendedHandling: 'Requires cross-module resolution, out of scope for the current same-file/same-module tier.'
        };
    }
}
