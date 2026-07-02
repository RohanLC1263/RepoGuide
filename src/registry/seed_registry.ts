import * as path from 'path';
import { LogicalUnitStore } from '../store/logicalUnitStore';
import { EntityRegistryStore } from './entityRegistryStore';
import { UUIDResolver } from './uuidResolver';

async function seedRegistry(repoRoot: string) {
    console.log(`Seeding registry from logical units for ${repoRoot}`);
    
    const unitStore = new LogicalUnitStore();
    await unitStore.init(repoRoot);
    const units = await unitStore.getAll();
    
    console.log(`Found ${units.length} logical units.`);

    const registryStore = new EntityRegistryStore();
    await registryStore.init(repoRoot);
    const resolver = new UUIDResolver(registryStore);

    for (const unit of units) {
        resolver.resolveUUID({
            filePath: unit.filePath,
            symbol: unit.symbol,
            type: unit.type
        });
    }

    console.log('Seeding complete. Run validate_registry.ts for metrics.');
    registryStore.close();
}

const repoRoot = process.argv[2] || process.cwd();
seedRegistry(repoRoot).catch(console.error);
