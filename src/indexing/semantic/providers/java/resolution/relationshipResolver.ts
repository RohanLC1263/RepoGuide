import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, JavaProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { JavaNameResolver } from './nameResolver';
import { JavaSourceRootResolver } from './sourceRootResolver';
import { findEnclosingTypeDeclaration, isInsideAnonymousClassBody, isInsideMethodBody } from '../astHelpers';

export interface JavaRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type JavaResolveResult =
    | { type: 'descriptor'; descriptor: JavaRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

/**
 * Per-node relationship rule engine, scoped per the honest-tier design:
 * DECLARES/IMPORTS are structural; EXTENDS/IMPLEMENTS are same-file/
 * same-project name lookups; INSTANTIATES is unambiguous (object_creation_
 * expression's `type` field, no heuristic needed -- unlike Python's
 * uppercase-callee guess); CALLS is same-class-only (bare/`this.` calls);
 * REFERENCES is excluded (Java's virtual-dispatch/reflection/dynamic-proxy
 * surface, not Python's dynamic-attribute-access reasoning, but the same
 * conclusion).
 */
export class JavaRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: JavaProgramHandle,
        nameResolver: JavaNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): JavaResolveResult[] {
        if (isInsideAnonymousClassBody(node)) {
            return []; // anonymous-class bodies are pruned entirely, see astHelpers.ts
        }
        switch (node.type) {
            case 'class_declaration':
            case 'interface_declaration':
            case 'enum_declaration':
                return isInsideMethodBody(node) ? [] : this.resolveDeclares(node, handle, moduleDescriptor);
            case 'method_declaration':
            case 'constructor_declaration':
                return this.resolveDeclares(node, handle, moduleDescriptor);
            case 'import_declaration':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'method_invocation':
                return this.resolveCall(node, handle, nameResolver);
            case 'object_creation_expression':
                return this.resolveInstantiate(node, handle, nameResolver);
            case 'explicit_constructor_invocation':
                return this.resolveConstructorDelegation(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /** class_declaration's superclass field -- called once per class, not routed through the generic switch above (see declarationVisitor.ts). */
    public static resolveExtends(classNode: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver): JavaResolveResult[] {
        const superclass = classNode.childForFieldName('superclass');
        const baseTypeNode = superclass?.namedChildren[0];
        if (!baseTypeNode) {
            return [];
        }
        const className = classNode.childForFieldName('name')?.text;
        if (!className) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(classNode, className, 'class', handle);
        const loc = this.locationOf(classNode, handle);
        return this.resolveTypeReference(baseTypeNode.text, sourceDescriptor, loc, nameResolver, handle, 'EXTENDS', 'Base class');
    }

    /**
     * IMPLEMENTS for both a class's `implements` clause and an interface's
     * own `extends` clause (interfaces can extend multiple interfaces) --
     * both are structurally "this type implements/extends these interface
     * types", so both map to IMPLEMENTS edges. Called once per type, not
     * routed through the generic switch (see declarationVisitor.ts).
     */
    public static resolveImplements(typeNode: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver): JavaResolveResult[] {
        const name = typeNode.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const kind = typeNode.type === 'interface_declaration' ? 'interface' : typeNode.type === 'enum_declaration' ? 'enum' : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(typeNode, name, kind, handle);
        const loc = this.locationOf(typeNode, handle);

        let typeList: Parser.SyntaxNode | undefined;
        if (typeNode.type === 'class_declaration' || typeNode.type === 'enum_declaration') {
            typeList = typeNode.childForFieldName('interfaces')?.namedChildren.find(c => c.type === 'type_list');
        } else {
            const extendsInterfaces = typeNode.namedChildren.find(c => c.type === 'extends_interfaces');
            typeList = extendsInterfaces?.namedChildren.find(c => c.type === 'type_list');
        }
        if (!typeList) {
            return [];
        }

        const results: JavaResolveResult[] = [];
        for (const typeRef of typeList.namedChildren) {
            if (typeRef.type !== 'type_identifier' && typeRef.type !== 'generic_type') {
                continue;
            }
            const baseName = typeRef.type === 'generic_type' ? (typeRef.childForFieldName('type')?.text ?? typeRef.text) : typeRef.text;
            results.push(...this.resolveTypeReference(baseName, sourceDescriptor, loc, nameResolver, handle, 'IMPLEMENTS', 'Implemented interface'));
        }
        return results;
    }

    private static resolveTypeReference(
        baseName: string,
        sourceDescriptor: IdentityDescriptor,
        loc: { filePath: string; startLine: number; endLine: number },
        nameResolver: JavaNameResolver,
        handle: JavaProgramHandle,
        relationshipKind: 'EXTENDS' | 'IMPLEMENTS',
        constructLabel: string
    ): JavaResolveResult[] {
        const targetNode = nameResolver.resolveTopLevelType(baseName);
        if (targetNode && (targetNode.type === 'class_declaration' || targetNode.type === 'interface_declaration' || targetNode.type === 'enum_declaration')) {
            const targetKind = targetNode.type === 'interface_declaration' ? 'interface' : targetNode.type === 'enum_declaration' ? 'enum' : 'class';
            const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, baseName, targetKind, handle);
            return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind, location: loc } }];
        }
        return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, constructLabel, `"${baseName}" is not declared in this file (likely a JDK type or an external/cross-file dependency) -- cross-file type resolution is out of scope.`) }];
    }

    private static resolveDeclares(node: Parser.SyntaxNode, handle: JavaProgramHandle, moduleDescriptor: IdentityDescriptor): JavaResolveResult[] {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const kind = node.type === 'interface_declaration' ? 'interface'
            : node.type === 'enum_declaration' ? 'enum'
            : (node.type === 'method_declaration' || node.type === 'constructor_declaration') ? 'method'
            : 'class';
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, kind, handle);
        const loc = this.locationOf(node, handle);

        const enclosing = findEnclosingTypeDeclaration(node);
        let sourceDescriptor: IdentityDescriptor;
        if (enclosing) {
            const enclosingName = enclosing.childForFieldName('name')?.text;
            if (!enclosingName) {
                return [];
            }
            const enclosingKind = enclosing.type === 'interface_declaration' ? 'interface' : enclosing.type === 'enum_declaration' ? 'enum' : 'class';
            sourceDescriptor = IdentityDescriptorBuilder.build(enclosing, enclosingName, enclosingKind, handle);
        } else {
            sourceDescriptor = moduleDescriptor; // top-level type -- DECLARES from the synthetic module entity
        }

        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveImports(node: Parser.SyntaxNode, handle: JavaProgramHandle, moduleDescriptor: IdentityDescriptor): JavaResolveResult[] {
        const loc = this.locationOf(node, handle);
        const scopedIdentifier = node.namedChildren.find(c => c.type === 'scoped_identifier' || c.type === 'identifier');
        if (!scopedIdentifier) {
            return [];
        }
        const fqn = scopedIdentifier.text;
        const sourceRoot = JavaSourceRootResolver.findSourceRoot(handle.filePath, handle.packageName);
        const resolvedFile = JavaSourceRootResolver.resolveImport(sourceRoot, fqn);

        if (!resolvedFile) {
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Import', `Could not resolve import "${fqn}" to a file under this project's source root (likely a JDK type or an external library dependency).`) }];
        }

        const targetPackage = fqn.split('.').slice(0, -1).join('.');
        const targetDescriptor: IdentityDescriptor = {
            package: 'workspace',
            logicalNamespace: targetPackage,
            qualifiedName: '',
            symbolKind: 'module',
            signatureHash: 'v1|0000000000000000',
            identityOrigin: 'Repository',
            identityAuthority: 'parser'
        };
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'IMPORTS', location: loc } }];
    }

    private static resolveCall(node: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver): JavaResolveResult[] {
        const methodName = node.childForFieldName('name')?.text;
        if (!methodName) {
            return [];
        }
        const objectNode = node.childForFieldName('object');
        // Only bare calls (no object) or `this.foo()` are attempted -- a call
        // through an arbitrary local variable (`b.doThing()`) would need the
        // variable's declared type resolved, which requires a type checker
        // this provider doesn't have.
        if (objectNode && objectNode.text !== 'this') {
            return [];
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

        const targetNode = nameResolver.resolveMethodOnEnclosingClass(node, methodName);
        if (!targetNode) {
            return []; // unresolved lowercase-shaped calls are common (JDK/external methods) -- not flagged as KnownUnknown to avoid noise, matching Python's tier
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, methodName, 'method', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    /**
     * `this(...)` constructor delegation (e.g. `RouteTracker(HttpHost, InetAddress) { this(target, local, null); }`)
     * resolves to a same-class constructor, same tier as a bare method call.
     * `super(...)` is not attempted -- the superclass is frequently declared
     * in a different file, and cross-file resolution is out of scope (same
     * boundary as EXTENDS).
     */
    private static resolveConstructorDelegation(node: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver): JavaResolveResult[] {
        const kind = node.childForFieldName('constructor')?.text;
        if (kind !== 'this') {
            return [];
        }
        const enclosingDef = this.findEnclosingMethodOrConstructor(node);
        if (!enclosingDef) {
            return [];
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingClass = findEnclosingTypeDeclaration(node);
        const className = enclosingClass?.childForFieldName('name')?.text;
        if (!className) {
            return [];
        }
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, 'method', handle);
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveMethodOnEnclosingClass(node, className);
        if (!targetNode || targetNode === enclosingDef) {
            return []; // no other same-name constructor indexed (overload collision -- see docs/engineering-log/JAVA_SEMANTIC_PROVIDER_REPORT.md) or resolved to itself
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, className, 'method', handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    private static resolveInstantiate(node: Parser.SyntaxNode, handle: JavaProgramHandle, nameResolver: JavaNameResolver): JavaResolveResult[] {
        const typeNode = node.childForFieldName('type');
        if (!typeNode) {
            return [];
        }
        const typeName = typeNode.type === 'generic_type' ? (typeNode.childForFieldName('type')?.text ?? typeNode.text) : typeNode.text;

        const enclosingDef = this.findEnclosingMethodOrConstructor(node) ?? findEnclosingTypeDeclaration(node);
        if (!enclosingDef) {
            return [];
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = enclosingDef.type === 'method_declaration' || enclosingDef.type === 'constructor_declaration' ? 'method'
            : enclosingDef.type === 'interface_declaration' ? 'interface'
            : enclosingDef.type === 'enum_declaration' ? 'enum'
            : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        const targetNode = nameResolver.resolveTopLevelType(typeName);
        if (!targetNode) {
            // Unlike Python's uppercase-heuristic guess, `new X()` is
            // syntactically unambiguous -- every unresolved instantiation is
            // worth flagging, since there's no false-positive risk from a
            // naming convention.
            return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Unresolved Instantiation', `"${typeName}" is not declared in this file (likely a JDK type or an external/cross-file dependency) -- cross-file type resolution is out of scope.`) }];
        }
        const targetKind = targetNode.type === 'interface_declaration' ? 'interface' : targetNode.type === 'enum_declaration' ? 'enum' : 'class';
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, typeName, targetKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'INSTANTIATES', location: loc } }];
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

    private static locationOf(node: Parser.SyntaxNode, handle: JavaProgramHandle) {
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
