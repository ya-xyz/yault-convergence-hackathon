/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
  ],
  moduleNameMapper: {
    // WASM module mock — tests should provide their own mock via jest.mock()
    '^.*wasm-core/pkg/.*$': '<rootDir>/tests/__mocks__/wasm-mock.js',
  },
  transform: {
    '^.+\\.(js|mjs)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/',
    'wasm-core/pkg/', // do not transform WASM glue
  ],
  modulePathIgnorePatterns: [
    '<rootDir>/contracts/lib/',
  ],
  // Increase timeout for integration tests that hit SQLite
  testTimeout: 15000,
};
