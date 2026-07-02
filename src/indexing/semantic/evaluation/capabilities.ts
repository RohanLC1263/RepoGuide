import { RepositoryEntity, RepositoryRelationship, KnownUnknown } from '../semanticProviderContract';

export interface CapabilityDefinition {
    id: string;
    displayName: string;
    
    // Declarative Evaluation Rules
    supportedEntityKinds?: string[];
    supportedRelationshipKinds?: string[];
    customRule?: (item: RepositoryEntity | RepositoryRelationship | KnownUnknown) => boolean;
}

export const REGISTRY_CAPABILITIES: CapabilityDefinition[] = [
    {
        id: 'cap_declarations',
        displayName: 'Declarations',
        supportedEntityKinds: ['class', 'interface', 'function', 'method', 'variable', 'enum', 'namespace', 'type_alias']
    },
    {
        id: 'cap_relationships',
        displayName: 'All Relationships',
        supportedRelationshipKinds: ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'INSTANTIATES', 'REFERENCES']
    },
    {
        id: 'cap_inheritance',
        displayName: 'Class Inheritance',
        supportedRelationshipKinds: ['EXTENDS', 'IMPLEMENTS']
    },
    {
        id: 'cap_calls',
        displayName: 'Call Graph',
        supportedRelationshipKinds: ['CALLS']
    },
    {
        id: 'cap_imports',
        displayName: 'Module Imports',
        supportedRelationshipKinds: ['IMPORTS']
    },
    {
        id: 'cap_known_unknowns',
        displayName: 'Known Unknowns',
        customRule: (item) => 'unsupportedConstruct' in item
    }
];
