// Maps node:test imports to Jest globals so test files work under both runners
const test = (global as any).test;
const describe = (global as any).describe;
const it = (global as any).it;
const beforeEach = (global as any).beforeEach;
const afterEach = (global as any).afterEach;
const before = (global as any).beforeAll;
const after = (global as any).afterAll;

export { describe, it, before, after, beforeEach, afterEach };
export default test;
