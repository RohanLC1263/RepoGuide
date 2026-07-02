import * as assert from 'assert';

suite('Node SQLite Feasibility Test', () => {
    test('Check process.versions', () => {
        console.log('--- FEASIBILITY LOGS ---');
        console.log('Node version:', process.versions.node);
        console.log('Electron version:', process.versions.electron);
        console.log('V8 version:', process.versions.v8);
    });

    test('Check node:sqlite availability', () => {
        try {
            const sqlite = require('node:sqlite');
            console.log('node:sqlite successfully required!');
            
            const { DatabaseSync } = sqlite;
            const db = new DatabaseSync(':memory:');
            db.exec("CREATE TABLE t (id INT)");
            db.exec("INSERT INTO t VALUES (42)");
            const row = db.prepare("SELECT * FROM t").get();
            console.log('node:sqlite query result:', row);
            
            assert.strictEqual(row.id, 42);
            console.log('--- SUCCESS: node:sqlite works in extension host ---');
        } catch (e: any) {
            console.error('Failed to require or use node:sqlite:', e);
            assert.fail('node:sqlite not available');
        }
    });
});
