module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '/node_modules/',
    '/eval_repos/',
    '/out/',
    'src/test/phase0Panels.test.ts',
    'src/test/extension.test.ts'
  ],
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json'
    }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^node:test$': '<rootDir>/src/test/__mocks__/node-test.ts',
    '^vscode$': '<rootDir>/src/test/__mocks__/vscode.ts'
  }
};
