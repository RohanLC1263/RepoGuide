import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, RustProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { RustNameResolver } from './nameResolver';
import { RustCrateResolver } from './crateResolver';
import { findEnclosingFunction, findEnclosingImplOrTrait, implTraitName, implTypeName, isInsideFunctionBody, unwrapGenericType } from '../astHelpers';

export interface RustRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type RustResolveResult =
    | { type: 'descriptor'; descriptor: RustRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

/**
 * Per-node relationship rule engine. DECLARES/IMPORTS are structural;
 * `impl Trait for Type` gives IMPLEMENTS a genuine tier improvement over
 * every prior provider (both names are directly field-accessible, unlike
 * C#'s ambiguous base_list or Go's total absence) -- classified only when
 * both the trait and the implementing type resolve locally, same-file
 * scope; `trait Sub: Super` supertrait bounds are EXTENDS, Rust's closest
 * analog since there's no struct inheritance; INSTANTIATES needs no
 * filtering (struct_expression is a distinct node type from tuple/array
 * expressions, unlike Go's shared composite_literal); CALLS is same-file,
 * resolving only `self.method()` and `Type::method()`/`Self::method()`
 * forms -- calls through an arbitrary variable aren't attempted, since
 * Rust has no receiver-variable-name convention to check against the way
 * Go's arbitrary receiver name at least offers one signal.
 */
export class RustRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: RustProgramHandle,
        nameResolver: RustNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): RustResolveResult[] {
        switch (node.type) {
            case 'struct_item':
                return this.resolveTypeDeclares(node, 'class', handle, moduleDescriptor);
            case 'enum_item':
                return this.resolveTypeDeclares(node, 'enum', handle, moduleDescriptor);
            case 'trait_item':
                return this.resolveTraitDeclares(node, handle, moduleDescriptor);
            case 'function_item':
                return this.resolveFunctionOrMethodDeclares(node, handle, nameResolver, moduleDescriptor);
            case 'use_declaration':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'call_expression':
                return this.resolveCall(node, handle, nameResolver);
            case 'struct_expression':
                return this.resolveInstantiate(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /**
     * Called once per impl_item that has a `trait` field (see
     * relationshipVisitor.ts), not routed through the generic switch.
     * Classified only when both the trait and the implementing type
     * resolve to a module-level declaration in this same file -- an
     * inherent `impl Type { ... }` block (no trait field) is not passed
     * here at all.
     */
    public static resolveImplements(implNode: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver, moduleDescriptor: IdentityDescriptor): RustResolveResult[] {
        if (isInsideFunctionBody(implNode)) {
            return [];
        }
        const typeName = implTypeName(implNode);
        const traitName = implTraitName(implNode);
        if (!typeName || !traitName) {
            return [];
        }
        const loc = this.locationOf(implNode, handle);

        const typeNode = nameResolver.resolveTopLevelType(typeName);
        if (!typeNode) {
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Impl target type', `"${typeName}" is not declared in this file (likely an external/cross-file type) -- cross-file type resolution is out of scope.`) }];
        }
        const traitNode = nameResolver.resolveTopLevelTrait(traitName);
        if (!traitNode) {
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Trait', `"${traitName}" is not declared in this file (likely a std trait such as Debug/Clone/From, or an external/cross-file trait) -- cross-file trait resolution is out of scope.`) }];
        }
        const sourceKind = typeNode.type === 'enum_item' ? 'enum' : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(typeNode, typeName, sourceKind, handle);
        const targetDescriptor = IdentityDescriptorBuilder.build(traitNode, traitName, 'interface', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'IMPLEMENTS', location: loc } }];
    }

    /**
     * Called once per trait_item (see relationshipVisitor.ts). Supertrait
     * bounds (`trait Sub: Super + Other`) map to EXTENDS -- Rust's closest
     * analog to the "extends" vocabulary, since traits have no
     * struct-style inheritance of their own. Multiple bounds emit
     * multiple EXTENDS edges, mirroring Go's multi-embedding precedent.
     */
    public static resolveSupertraits(traitNode: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver): RustResolveResult[] {
        if (isInsideFunctionBody(traitNode)) {
            return [];
        }
        const name = traitNode.childForFieldName('name')?.text;
        const bounds = traitNode.childForFieldName('bounds');
        if (!name || !bounds) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(traitNode, name, 'interface', handle);
        const loc = this.locationOf(traitNode, handle);

        const results: RustResolveResult[] = [];
        for (const bound of bounds.namedChildren) {
            if (bound.type === 'lifetime') {
                continue; // `'static`/etc. -- a real bound, but not a trait; silently skipped, not noise
            }
            const boundName = unwrapGenericType(bound)?.text;
            if (!boundName) {
                continue;
            }
            const targetNode = nameResolver.resolveTopLevelTrait(boundName);
            if (!targetNode) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Supertrait bound', `"${boundName}" is not declared in this file (likely a std trait such as Clone/Send/Sync, or an external/cross-file trait) -- cross-file trait resolution is out of scope.`) });
                continue;
            }
            const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, boundName, 'interface', handle);
            results.push({ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'EXTENDS', location: loc } });
        }
        return results;
    }

    private static resolveTypeDeclares(node: Parser.SyntaxNode, kind: 'class' | 'enum', handle: RustProgramHandle, moduleDescriptor: IdentityDescriptor): RustResolveResult[] {
        if (isInsideFunctionBody(node)) {
            return [];
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, kind, handle);
        const loc = this.locationOf(node, handle);
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveTraitDeclares(node: Parser.SyntaxNode, handle: RustProgramHandle, moduleDescriptor: IdentityDescriptor): RustResolveResult[] {
        if (isInsideFunctionBody(node)) {
            return [];
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'interface', handle);
        const loc = this.locationOf(node, handle);
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    /**
     * A function_item is either a plain module-level function or a method
     * (self-taking or associated) declared inside an impl/trait block --
     * distinguished only by its enclosing node, never by AST nesting the
     * way Java/C# nest members inside a class body (see
     * DeclarationClassifier). A local `fn` nested inside another
     * function's body is real, legal Rust and is pruned here exactly as
     * declarationClassifier prunes it from entity extraction.
     */
    private static resolveFunctionOrMethodDeclares(node: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver, moduleDescriptor: IdentityDescriptor): RustResolveResult[] {
        if (isInsideFunctionBody(node)) {
            return [];
        }
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const enclosing = findEnclosingImplOrTrait(node);
        const loc = this.locationOf(node, handle);

        if (!enclosing) {
            const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'function', handle);
            return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }

        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'method', handle);
        if (enclosing.type === 'trait_item') {
            const traitName = enclosing.childForFieldName('name')?.text;
            if (!traitName) {
                return [];
            }
            const sourceDescriptor = IdentityDescriptorBuilder.build(enclosing, traitName, 'interface', handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
        }

        // enclosing.type === 'impl_item'
        const typeName = implTypeName(enclosing);
        if (!typeName) {
            return [];
        }
        const typeNode = nameResolver.resolveTopLevelType(typeName);
        if (!typeNode) {
            // The impl'd type isn't declared in this file -- a real,
            // disclosed gap (mirrors Go's "Receiver type" unknown): same-file
            // scope was chosen for consistency with every prior provider and
            // was empirically checked against real reqwest code (2/108 impl
            // targets split cross-file), not assumed to be zero-cost.
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Impl target type', `"${typeName}" is not declared in this file -- same-file-only scope means this method's owning type can't be linked here.`) }];
        }
        const sourceKind = typeNode.type === 'enum_item' ? 'enum' : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(typeNode, typeName, sourceKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveImports(node: Parser.SyntaxNode, handle: RustProgramHandle, moduleDescriptor: IdentityDescriptor): RustResolveResult[] {
        const argument = node.childForFieldName('argument');
        if (!argument) {
            return [];
        }
        const loc = this.locationOf(node, handle);
        const paths = this.collectUsePaths(argument, '');

        const results: RustResolveResult[] = [];
        for (const usePath of paths) {
            const resolvedFile = RustCrateResolver.resolveUse(usePath, handle.filePath, handle.crateRoot, handle.crateName);
            if (!resolvedFile) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Import', `Could not resolve "${usePath}" to a file under this crate's src/ root (likely std/core/alloc or an external crate dependency).`) });
                continue;
            }
            const targetModulePath = RustCrateResolver.computeModulePath(resolvedFile, handle.crateRoot, handle.crateName);
            const targetDescriptor: IdentityDescriptor = {
                package: 'workspace',
                logicalNamespace: targetModulePath,
                qualifiedName: '',
                symbolKind: 'module',
                signatureHash: 'v1|0000000000000000',
                identityOrigin: 'Repository',
                identityAuthority: 'parser'
            };
            results.push({ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'IMPORTS', location: loc } });
        }
        return results;
    }

    /**
     * Recursively walks a use_declaration's `argument` field, which is one
     * of: a plain `scoped_identifier`/`identifier` (a single import), a
     * `use_wildcard` (`use foo::*` -- a glob has no single target, skipped
     * entirely, not attempted), or a `scoped_use_list`/`use_list` group
     * (`use foo::{Bar, baz::Qux}`), which can nest arbitrarily deep
     * (`use std::{fmt, io::{Read, Write}}`) -- confirmed via direct AST
     * dump, not assumed to be flat.
     */
    private static collectUsePaths(node: Parser.SyntaxNode, prefix: string): string[] {
        switch (node.type) {
            case 'scoped_identifier':
            case 'identifier':
                return [prefix ? `${prefix}::${node.text}` : node.text];
            case 'self':
                return prefix ? [prefix] : [];
            case 'use_wildcard':
                return []; // glob import -- no single resolvable target
            case 'use_as_clause': {
                const original = node.namedChildren[0];
                return original ? this.collectUsePaths(original, prefix) : [];
            }
            case 'scoped_use_list': {
                const prefixNode = node.namedChildren.find(c => c.type !== 'use_list');
                const listNode = node.namedChildren.find(c => c.type === 'use_list');
                if (!prefixNode || !listNode) {
                    return [];
                }
                const newPrefix = prefix ? `${prefix}::${prefixNode.text}` : prefixNode.text;
                return listNode.namedChildren.flatMap(item => this.collectUsePaths(item, newPrefix));
            }
            case 'use_list':
                return node.namedChildren.flatMap(item => this.collectUsePaths(item, prefix));
            default:
                return [];
        }
    }

    /**
     * Resolves only `self.method()` (self-receiver field_expression) and
     * `Type::method()`/`Self::method()` (scoped_identifier associated-call)
     * forms. A call through an arbitrary variable (`client.get()`) isn't
     * attempted -- Rust has no receiver-variable-name convention to check
     * a call's target type against the way Go's arbitrary-but-consistent
     * receiver name at least offers one signal; this is a real, disclosed
     * narrower CALLS tier than Go's, not an oversight.
     */
    private static resolveCall(node: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver): RustResolveResult[] {
        const fn = node.childForFieldName('function');
        if (!fn) {
            return [];
        }
        const enclosingFn = findEnclosingFunction(node);
        if (!enclosingFn) {
            return []; // a const/static initializer calling something -- no enclosing function to be the source
        }
        const enclosingName = enclosingFn.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingImplOrTrait = findEnclosingImplOrTrait(enclosingFn);
        const enclosingKind = enclosingImplOrTrait ? 'method' : 'function';
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingFn, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        let targetNode: Parser.SyntaxNode | null = null;
        if (fn.type === 'field_expression') {
            const receiver = fn.childForFieldName('value')?.text;
            const methodName = fn.childForFieldName('field')?.text;
            if (receiver === 'self' && methodName && enclosingImplOrTrait?.type === 'impl_item') {
                const typeName = implTypeName(enclosingImplOrTrait);
                if (typeName) {
                    targetNode = nameResolver.resolveMethodOnType(typeName, methodName);
                }
            }
        } else if (fn.type === 'scoped_identifier') {
            const pathText = fn.childForFieldName('path')?.text;
            const methodName = fn.childForFieldName('name')?.text;
            if (pathText && methodName) {
                let typeName: string | null = pathText;
                if (pathText === 'Self') {
                    typeName = enclosingImplOrTrait?.type === 'impl_item' ? implTypeName(enclosingImplOrTrait) : null;
                }
                if (typeName) {
                    targetNode = nameResolver.resolveMethodOnType(typeName, methodName);
                }
            }
        }
        if (!targetNode) {
            return []; // unresolved calls are common (stdlib/external functions, or a call through an arbitrary variable) -- not flagged as KnownUnknown to avoid noise, matching every previous provider's tier
        }
        const targetName = targetNode.childForFieldName('name')?.text;
        if (!targetName) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, targetName, 'method', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    /**
     * struct_expression is a genuinely distinct node type from
     * tuple_expression/array_expression (confirmed via direct AST dump --
     * unlike Go's shared composite_literal), so this needs no filtering:
     * every struct_expression is a real struct-literal instantiation.
     */
    private static resolveInstantiate(node: Parser.SyntaxNode, handle: RustProgramHandle, nameResolver: RustNameResolver): RustResolveResult[] {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
            return [];
        }
        const rawName = unwrapGenericType(nameNode)?.text ?? nameNode.text;
        // A path-qualified literal (`module::Foo { .. }`) resolves against
        // this file's bare top-level name index -- same-file scope means
        // the module prefix itself is never meaningfully resolvable here.
        const typeName = rawName.includes('::') ? rawName.split('::').pop()! : rawName;

        const enclosingFn = findEnclosingFunction(node);
        if (!enclosingFn) {
            return [];
        }
        const enclosingName = enclosingFn.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = findEnclosingImplOrTrait(enclosingFn) ? 'method' : 'function';
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingFn, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveTopLevelType(typeName);
        if (!targetNode) {
            return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Unresolved Instantiation', `"${typeName}" is not declared in this file (likely a stdlib type or an external/cross-file dependency) -- cross-file type resolution is out of scope.`) }];
        }
        const targetKind = targetNode.type === 'enum_item' ? 'enum' : 'class';
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, typeName, targetKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'INSTANTIATES', location: loc } }];
    }

    private static locationOf(node: Parser.SyntaxNode, handle: RustProgramHandle) {
        return { filePath: handle.filePath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
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
            recommendedHandling: 'Requires cross-file/cross-crate resolution, out of scope for the current same-file tier.'
        };
    }
}
