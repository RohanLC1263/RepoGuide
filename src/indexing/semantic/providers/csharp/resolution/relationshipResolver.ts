import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, CSharpProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { CSharpNameResolver } from './nameResolver';
import { CSharpNamespaceResolver } from './namespaceResolver';
import { findEnclosingTypeDeclaration } from '../astHelpers';

export interface CSharpRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type CSharpResolveResult =
    | { type: 'descriptor'; descriptor: CSharpRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

const TYPE_DECLARATION_KINDS = new Set(['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration']);

/**
 * Per-node relationship rule engine. DECLARES/IMPORTS are structural;
 * base-list entries (EXTENDS/IMPLEMENTS) are classified only when they
 * resolve locally, since C# has no syntactic distinction between "extends"
 * and "implements" the way Java does (see resolveBaseList); INSTANTIATES
 * is unambiguous (object_creation_expression's `type` field); CALLS is
 * same-type-only (bare/`this.` calls); REFERENCES is excluded (C#'s
 * virtual-dispatch/reflection surface, independently justified from
 * Java's identical conclusion).
 */
export class CSharpRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: CSharpProgramHandle,
        nameResolver: CSharpNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): CSharpResolveResult[] {
        if (TYPE_DECLARATION_KINDS.has(node.type)) {
            return this.resolveDeclares(node, handle, moduleDescriptor);
        }
        switch (node.type) {
            case 'method_declaration':
            case 'constructor_declaration':
                return this.resolveDeclares(node, handle, moduleDescriptor);
            case 'using_directive':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'invocation_expression':
                return this.resolveCall(node, handle, nameResolver);
            case 'object_creation_expression':
                return this.resolveInstantiate(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /**
     * C#'s `base_list` (`class Foo : Base, IDisposable`) has no syntactic
     * marker for which entries are the base class vs. implemented
     * interfaces -- unlike Java's separate `superclass`/`interfaces`
     * fields. Classified by the resolved target's own node kind only when
     * it resolves locally; an unresolved entry (the common case -- most
     * base types are external or cross-file) becomes a single, honestly
     * generic "Base type or interface" KnownUnknown rather than guessing
     * which relationship kind applies. Called once per type declaration,
     * not routed through the generic switch above (see declarationVisitor.ts).
     */
    public static resolveBaseList(typeNode: Parser.SyntaxNode, handle: CSharpProgramHandle, nameResolver: CSharpNameResolver): CSharpResolveResult[] {
        const baseList = typeNode.namedChildren.find(c => c.type === 'base_list');
        if (!baseList) {
            return [];
        }
        const name = typeNode.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const sourceKind = this.entityKindOf(typeNode);
        const sourceDescriptor = IdentityDescriptorBuilder.build(typeNode, name, sourceKind, handle);
        const loc = this.locationOf(typeNode, handle);

        const results: CSharpResolveResult[] = [];
        for (const baseRef of baseList.namedChildren) {
            if (baseRef.type !== 'identifier' && baseRef.type !== 'generic_name') {
                continue; // qualified/other base-type shapes not attempted in v1
            }
            const baseName = baseRef.type === 'generic_name' ? (baseRef.namedChildren[0]?.text ?? baseRef.text) : baseRef.text;
            const targetNode = nameResolver.resolveTopLevelType(baseName);

            if (!targetNode || !TYPE_DECLARATION_KINDS.has(targetNode.type)) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Base type or interface', `"${baseName}" is not declared in this file (likely a BCL/NuGet type or an external/cross-file dependency), and C#'s base-list syntax doesn't distinguish a base class from an implemented interface -- cross-file type resolution is out of scope.`) });
                continue;
            }
            const targetKind = this.entityKindOf(targetNode);
            const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, baseName, targetKind, handle);
            const relationshipKind = targetNode.type === 'interface_declaration' ? 'IMPLEMENTS' : 'EXTENDS';
            results.push({ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind, location: loc } });
        }
        return results;
    }

    /**
     * `this(...)` constructor delegation resolves to a same-type
     * constructor, same tier as a bare method call. `base(...)` is not
     * attempted -- the base type is frequently declared in a different
     * file, same boundary as the base-list resolution above. Called once
     * per constructor, not routed through the generic switch (see
     * declarationVisitor.ts).
     */
    public static resolveConstructorInitializer(ctorNode: Parser.SyntaxNode, handle: CSharpProgramHandle, nameResolver: CSharpNameResolver): CSharpResolveResult[] {
        const initializer = ctorNode.namedChildren.find(c => c.type === 'constructor_initializer');
        if (!initializer) {
            return [];
        }
        const kind = initializer.children.find(c => !c.isNamed && (c.type === 'this' || c.type === 'base'))?.type;
        if (kind !== 'this') {
            return [];
        }
        const enclosingType = findEnclosingTypeDeclaration(ctorNode);
        const typeName = enclosingType?.childForFieldName('name')?.text;
        const ctorName = ctorNode.childForFieldName('name')?.text;
        if (!typeName || !ctorName) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(ctorNode, ctorName, 'method', handle);
        const loc = this.locationOf(initializer, handle);

        const targetNode = nameResolver.resolveMethodOnEnclosingType(ctorNode, typeName);
        if (!targetNode || targetNode === ctorNode) {
            return []; // ambiguous (2+ constructors, the only real case this(...) appears in) or resolves to itself
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, typeName, 'method', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    private static resolveDeclares(node: Parser.SyntaxNode, handle: CSharpProgramHandle, moduleDescriptor: IdentityDescriptor): CSharpResolveResult[] {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const kind = node.type === 'method_declaration' || node.type === 'constructor_declaration' ? 'method' : this.entityKindOf(node);
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, kind, handle);
        const loc = this.locationOf(node, handle);

        const enclosing = findEnclosingTypeDeclaration(node);
        let sourceDescriptor: IdentityDescriptor;
        if (enclosing) {
            const enclosingName = enclosing.childForFieldName('name')?.text;
            if (!enclosingName) {
                return [];
            }
            sourceDescriptor = IdentityDescriptorBuilder.build(enclosing, enclosingName, this.entityKindOf(enclosing), handle);
        } else {
            sourceDescriptor = moduleDescriptor; // top-level type -- DECLARES from the synthetic module entity
        }

        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveImports(node: Parser.SyntaxNode, handle: CSharpProgramHandle, moduleDescriptor: IdentityDescriptor): CSharpResolveResult[] {
        const loc = this.locationOf(node, handle);
        const target = node.namedChildren.find(c => c.type === 'qualified_name' || c.type === 'identifier');
        if (!target) {
            return [];
        }
        const fqn = target.text;
        const sourceRoot = CSharpNamespaceResolver.findSourceRoot(handle.filePath, handle.namespaceName);
        const resolved = CSharpNamespaceResolver.resolveImport(sourceRoot, fqn);

        if (!resolved) {
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Import', `Could not resolve "using ${fqn}" to a file or namespace directory under this project's source root (likely a BCL type or an external NuGet dependency).`) }];
        }

        // A namespace-shaped using (the common case, e.g. "using RestSharp.Authenticators;")
        // resolves to the namespace itself; a specific-type using resolves to
        // that type's containing namespace, same as before.
        const targetNamespace = resolved.isNamespace ? fqn : fqn.split('.').slice(0, -1).join('.');
        const targetDescriptor: IdentityDescriptor = {
            package: 'workspace',
            logicalNamespace: targetNamespace,
            qualifiedName: '',
            symbolKind: 'module',
            signatureHash: 'v1|0000000000000000',
            identityOrigin: 'Repository',
            identityAuthority: 'parser'
        };
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'IMPORTS', location: loc } }];
    }

    private static resolveCall(node: Parser.SyntaxNode, handle: CSharpProgramHandle, nameResolver: CSharpNameResolver): CSharpResolveResult[] {
        const functionNode = node.childForFieldName('function');
        if (!functionNode) {
            return [];
        }

        let methodName: string | null = null;
        if (functionNode.type === 'identifier') {
            methodName = functionNode.text;
        } else if (functionNode.type === 'member_access_expression') {
            const objectText = functionNode.childForFieldName('expression')?.text;
            if (objectText === 'this') {
                methodName = functionNode.childForFieldName('name')?.text ?? null;
            }
        }
        if (!methodName) {
            return []; // bare or `this.` calls only -- a call through an arbitrary variable needs type inference this provider doesn't have
        }

        const enclosingDef = this.findEnclosingMethodOrConstructor(node);
        if (!enclosingDef) {
            return [];
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, 'method', handle);
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveMethodOnEnclosingType(node, methodName);
        if (!targetNode) {
            return []; // unresolved calls are common (BCL/external methods, or ambiguous overloads) -- not flagged as KnownUnknown to avoid noise, matching Java's tier
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, methodName, 'method', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    private static resolveInstantiate(node: Parser.SyntaxNode, handle: CSharpProgramHandle, nameResolver: CSharpNameResolver): CSharpResolveResult[] {
        const typeNode = node.childForFieldName('type');
        if (!typeNode) {
            return [];
        }
        const typeName = typeNode.type === 'generic_name' ? (typeNode.namedChildren[0]?.text ?? typeNode.text) : typeNode.text;

        const enclosingDef = this.findEnclosingMethodOrConstructor(node) ?? findEnclosingTypeDeclaration(node);
        if (!enclosingDef) {
            return [];
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = enclosingDef.type === 'method_declaration' || enclosingDef.type === 'constructor_declaration' ? 'method' : this.entityKindOf(enclosingDef);
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveTopLevelType(typeName);
        if (!targetNode) {
            // `new X()` is syntactically unambiguous -- every unresolved
            // instantiation is worth flagging, no false-positive risk from
            // a naming convention (unlike Python's uppercase-guess tier).
            return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Unresolved Instantiation', `"${typeName}" is not declared in this file (likely a BCL type or an external/cross-file dependency) -- cross-file type resolution is out of scope.`) }];
        }
        const targetKind = this.entityKindOf(targetNode);
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, typeName, targetKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'INSTANTIATES', location: loc } }];
    }

    private static entityKindOf(node: Parser.SyntaxNode): 'class' | 'interface' | 'enum' {
        if (node.type === 'interface_declaration') return 'interface';
        if (node.type === 'enum_declaration') return 'enum';
        return 'class';
    }

    private static findEnclosingMethodOrConstructor(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
        let current: Parser.SyntaxNode | null = node.parent;
        while (current) {
            if (current.type === 'method_declaration' || current.type === 'constructor_declaration') {
                return current;
            }
            current = current.parent;
        }
        return null;
    }

    private static locationOf(node: Parser.SyntaxNode, handle: CSharpProgramHandle) {
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
            recommendedHandling: 'Requires cross-file/cross-package resolution, out of scope for the current same-file tier.'
        };
    }
}
