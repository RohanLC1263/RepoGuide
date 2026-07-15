import Parser = require('node-tree-sitter');
import { KnownUnknown } from '../../../semanticProviderContract';
import { IdentityDescriptor, GoProgramHandle } from '../internalModels';
import { IdentityDescriptorBuilder } from './identityDescriptorBuilder';
import { GoNameResolver } from './nameResolver';
import { GoModuleResolver } from './moduleResolver';
import { embeddedFieldTypeName, findEnclosingFunctionOrMethod, isEmbeddedField, receiverTypeName, receiverVarName } from '../astHelpers';

export interface GoRelationshipDescriptor {
    source: IdentityDescriptor;
    target: IdentityDescriptor;
    relationshipKind: 'DECLARES' | 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'INSTANTIATES';
    location: { filePath: string; startLine: number; endLine: number };
}

export type GoResolveResult =
    | { type: 'descriptor'; descriptor: GoRelationshipDescriptor }
    | { type: 'unknown'; unknown: KnownUnknown };

/**
 * Per-node relationship rule engine. DECLARES/IMPORTS are structural;
 * struct/interface embedding (Go's closest EXTENDS analog) is classified
 * only when the embedded type resolves locally; INSTANTIATES needs an
 * explicit filter (composite_literal is shared with slice/map/array
 * literals, unlike Java's/C#'s unambiguous `new`); CALLS is same-file,
 * receiver-variable-aware. IMPLEMENTS is not attempted at all -- Go gives
 * no syntax for interface satisfaction to even heuristically approximate,
 * a real disclosed tier regression from Java/C#, not a scoping choice.
 */
export class GoRelationshipResolver {
    public static resolve(
        node: Parser.SyntaxNode,
        handle: GoProgramHandle,
        nameResolver: GoNameResolver,
        moduleDescriptor: IdentityDescriptor
    ): GoResolveResult[] {
        switch (node.type) {
            case 'type_declaration':
                return this.resolveTypeDeclares(node, handle, moduleDescriptor);
            case 'function_declaration':
                return this.resolveFunctionDeclares(node, handle, moduleDescriptor);
            case 'method_declaration':
                return this.resolveMethodDeclares(node, handle, nameResolver, moduleDescriptor);
            case 'import_declaration':
                return this.resolveImports(node, handle, moduleDescriptor);
            case 'call_expression':
                return this.resolveCall(node, handle, nameResolver);
            case 'composite_literal':
                return this.resolveInstantiate(node, handle, nameResolver);
            default:
                return [];
        }
    }

    /**
     * Struct/interface embedding -- Go's closest EXTENDS analog. Called once
     * per type_declaration's type_spec, not routed through the generic
     * switch (see declarationVisitor.ts). Both struct-embeds-struct and
     * struct-embeds-interface map to EXTENDS: this is composition/embedding
     * labeled with the nearest existing schema vocabulary, not literal OO
     * inheritance -- stated honestly, not silently overloaded.
     */
    public static resolveEmbedding(typeSpec: Parser.SyntaxNode, handle: GoProgramHandle, nameResolver: GoNameResolver, moduleDescriptor: IdentityDescriptor): GoResolveResult[] {
        const name = typeSpec.childForFieldName('name')?.text;
        const typeNode = typeSpec.childForFieldName('type');
        if (!name || !typeNode) {
            return [];
        }
        const sourceKind = typeNode.type === 'interface_type' ? 'interface' : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(typeSpec, name, sourceKind, handle);
        const loc = this.locationOf(typeSpec, handle);
        const results: GoResolveResult[] = [];

        if (typeNode.type === 'struct_type') {
            // struct_type has no working 'body' field name (confirmed via
            // direct testing) -- its field_declaration_list is its only
            // namedChild, found positionally instead.
            const fieldList = typeNode.namedChildren.find(c => c.type === 'field_declaration_list');
            for (const field of fieldList?.namedChildren ?? []) {
                if (field.type !== 'field_declaration' || !isEmbeddedField(field)) {
                    continue;
                }
                const embeddedName = embeddedFieldTypeName(field);
                if (embeddedName) {
                    results.push(this.classifyEmbedding(embeddedName, sourceDescriptor, loc, nameResolver, handle));
                }
            }
        } else if (typeNode.type === 'interface_type') {
            for (const elem of typeNode.namedChildren) {
                if (elem.type !== 'type_elem') {
                    continue;
                }
                const embeddedName = elem.namedChildren[0]?.text;
                if (embeddedName) {
                    results.push(this.classifyEmbedding(embeddedName, sourceDescriptor, loc, nameResolver, handle));
                }
            }
        }
        return results;
    }

    private static classifyEmbedding(embeddedName: string, sourceDescriptor: IdentityDescriptor, loc: { filePath: string; startLine: number; endLine: number }, nameResolver: GoNameResolver, handle: GoProgramHandle): GoResolveResult {
        const targetSpec = nameResolver.resolveTopLevelType(embeddedName);
        if (!targetSpec) {
            return { type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Embedded type', `"${embeddedName}" is not declared in this file (likely a stdlib or external/cross-file type) -- cross-file type resolution is out of scope.`) };
        }
        const targetKind = targetSpec.childForFieldName('type')?.type === 'interface_type' ? 'interface' : 'class';
        const targetDescriptor = IdentityDescriptorBuilder.build(targetSpec, embeddedName, targetKind, handle);
        return { type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'EXTENDS', location: loc } };
    }

    /** Package-level struct/interface types DECLARES from the synthetic module entity, mirroring resolveFunctionDeclares. type_alias specs are skipped, same as declarationVisitor.ts. */
    private static resolveTypeDeclares(node: Parser.SyntaxNode, handle: GoProgramHandle, moduleDescriptor: IdentityDescriptor): GoResolveResult[] {
        const results: GoResolveResult[] = [];
        for (const spec of node.namedChildren) {
            if (spec.type !== 'type_spec') {
                continue;
            }
            const name = spec.childForFieldName('name')?.text;
            const typeNode = spec.childForFieldName('type');
            if (!name || (typeNode?.type !== 'struct_type' && typeNode?.type !== 'interface_type')) {
                continue;
            }
            const kind = typeNode.type === 'interface_type' ? 'interface' : 'class';
            const targetDescriptor = IdentityDescriptorBuilder.build(spec, name, kind, handle);
            const loc = this.locationOf(spec, handle);
            results.push({ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } });
        }
        return results;
    }

    private static resolveFunctionDeclares(node: Parser.SyntaxNode, handle: GoProgramHandle, moduleDescriptor: IdentityDescriptor): GoResolveResult[] {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'function', handle);
        const loc = this.locationOf(node, handle);
        return [{ type: 'descriptor', descriptor: { source: moduleDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveMethodDeclares(node: Parser.SyntaxNode, handle: GoProgramHandle, nameResolver: GoNameResolver, moduleDescriptor: IdentityDescriptor): GoResolveResult[] {
        const name = node.childForFieldName('name')?.text;
        const receiver = receiverTypeName(node);
        if (!name || !receiver) {
            return [];
        }
        const targetDescriptor = IdentityDescriptorBuilder.build(node, name, 'method', handle);
        const loc = this.locationOf(node, handle);

        const receiverSpec = nameResolver.resolveTopLevelType(receiver);
        if (!receiverSpec) {
            // The receiver struct isn't declared in this file -- a real,
            // disclosed gap (see docs/engineering-log/GO_SEMANTIC_PROVIDER_REPORT.md): same-file
            // scope was chosen for consistency with the other providers, and
            // was empirically checked against real resty code, but a
            // differently-organized Go codebase could hit this often.
            return [{ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Receiver type', `"${receiver}" is not declared in this file -- same-file-only scope means this method's owning struct can't be linked here.`) }];
        }
        const receiverKind = receiverSpec.childForFieldName('type')?.type === 'interface_type' ? 'interface' : 'class';
        const sourceDescriptor = IdentityDescriptorBuilder.build(receiverSpec, receiver, receiverKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'DECLARES', location: loc } }];
    }

    private static resolveImports(node: Parser.SyntaxNode, handle: GoProgramHandle, moduleDescriptor: IdentityDescriptor): GoResolveResult[] {
        const loc = this.locationOf(node, handle);
        const specs: Parser.SyntaxNode[] = [];
        for (const child of node.namedChildren) {
            if (child.type === 'import_spec') specs.push(child);
            else if (child.type === 'import_spec_list') specs.push(...child.namedChildren.filter(c => c.type === 'import_spec'));
        }

        const results: GoResolveResult[] = [];
        for (const spec of specs) {
            const rawPath = spec.childForFieldName('path')?.text;
            if (!rawPath) continue;
            const importPath = rawPath.replace(/^"|"$/g, '');
            const resolvedDir = GoModuleResolver.resolveImport(importPath, handle.moduleRoot, handle.modulePath);

            if (!resolvedDir) {
                results.push({ type: 'unknown', unknown: this.knownUnknown(moduleDescriptor, loc, 'Unresolved Import', `Could not resolve "${importPath}" to a package directory under this module's root (likely a stdlib package or an external Go module dependency).`) });
                continue;
            }
            const targetDescriptor: IdentityDescriptor = {
                package: 'workspace',
                logicalNamespace: importPath,
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

    private static resolveCall(node: Parser.SyntaxNode, handle: GoProgramHandle, nameResolver: GoNameResolver): GoResolveResult[] {
        const fn = node.childForFieldName('function');
        if (!fn) {
            return [];
        }
        const enclosingDef = findEnclosingFunctionOrMethod(node);
        if (!enclosingDef) {
            return []; // package-level var initializer calling something -- no enclosing function/method to be the source
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = enclosingDef.type === 'method_declaration' ? 'method' : 'function';
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        let targetNode: Parser.SyntaxNode | null = null;
        if (fn.type === 'identifier') {
            targetNode = nameResolver.resolveTopLevelFunction(fn.text);
        } else if (fn.type === 'selector_expression' && enclosingDef.type === 'method_declaration') {
            // Go has no `this`/`self` keyword -- the receiver variable name is
            // arbitrary per-method, so a same-struct call is only detectable
            // by checking the selector's operand against *this* method's own
            // declared receiver variable name.
            const operand = fn.childForFieldName('operand')?.text;
            const receiverVar = receiverVarName(enclosingDef);
            const receiverType = receiverTypeName(enclosingDef);
            if (operand && receiverVar && operand === receiverVar && receiverType) {
                const methodName = fn.childForFieldName('field')?.text;
                if (methodName) {
                    targetNode = nameResolver.resolveMethodOnType(receiverType, methodName);
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
        const targetKind = targetNode.type === 'method_declaration' ? 'method' : 'function';
        const targetDescriptor = IdentityDescriptorBuilder.build(targetNode, targetName, targetKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'CALLS', location: loc } }];
    }

    private static resolveInstantiate(node: Parser.SyntaxNode, handle: GoProgramHandle, nameResolver: GoNameResolver): GoResolveResult[] {
        const typeNode = node.childForFieldName('type');
        // composite_literal is shared by struct/slice/map/array literals --
        // only a plain type_identifier (a named type reference) is a
        // struct-shaped instantiation; slice_type/map_type/array_type are
        // container literals, not instantiations of a locally-declared type,
        // and must be excluded to avoid false positives (verified via direct
        // testing, not assumed -- see docs/engineering-log/GO_SEMANTIC_PROVIDER_REPORT.md).
        if (!typeNode || typeNode.type !== 'type_identifier') {
            return [];
        }
        const typeName = typeNode.text;

        const enclosingDef = findEnclosingFunctionOrMethod(node);
        if (!enclosingDef) {
            return [];
        }
        const enclosingName = enclosingDef.childForFieldName('name')?.text;
        if (!enclosingName) {
            return [];
        }
        const enclosingKind = enclosingDef.type === 'method_declaration' ? 'method' : 'function';
        const sourceDescriptor = IdentityDescriptorBuilder.build(enclosingDef, enclosingName, enclosingKind, handle);
        const loc = this.locationOf(node, handle);

        const targetSpec = nameResolver.resolveTopLevelType(typeName);
        if (!targetSpec) {
            return [{ type: 'unknown', unknown: this.knownUnknown(sourceDescriptor, loc, 'Unresolved Instantiation', `"${typeName}" is not declared in this file (likely a stdlib type or an external/cross-file dependency) -- cross-file type resolution is out of scope.`) }];
        }
        const targetKind = targetSpec.childForFieldName('type')?.type === 'interface_type' ? 'interface' : 'class';
        const targetDescriptor = IdentityDescriptorBuilder.build(targetSpec, typeName, targetKind, handle);
        return [{ type: 'descriptor', descriptor: { source: sourceDescriptor, target: targetDescriptor, relationshipKind: 'INSTANTIATES', location: loc } }];
    }

    private static locationOf(node: Parser.SyntaxNode, handle: GoProgramHandle) {
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
