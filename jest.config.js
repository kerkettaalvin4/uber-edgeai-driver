module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$': '<rootDir>/tests/mocks/AsyncStorageMock.ts',
  },
  testPathIgnorePatterns: ['/node_modules/', '/work/', '/backend/'],
  cacheDirectory: '<rootDir>/work/jest-cache',
};

