/**
 * Jest + React Native Testing Library for mobile components and router integration.
 * Two projects map to CI steps: `mobile-unit` (src/**) and `mobile-integration` (tests/mobile/**).
 */
const expoPreset = require('jest-expo/jest-preset');

// Extend (never replace) jest-expo's allow-list with ESM packages used by SiteMuster.
const extraTransformed = [
  'i18next',
  'react-i18next',
  '@noble',
  'zod',
  '@sitemuster',
  'react-native-svg',
];
const [firstPattern, ...restPatterns] = expoPreset.transformIgnorePatterns;
const transformIgnorePatterns = [
  firstPattern.replace('(?!(', `(?!(${extraTransformed.join('|')}|`),
  ...restPatterns,
];

const base = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.ts'],
  transformIgnorePatterns,
};

module.exports = {
  projects: [
    { ...base, displayName: 'mobile-unit', testMatch: ['<rootDir>/src/**/*.test.tsx'] },
    {
      ...base,
      displayName: 'mobile-integration',
      testMatch: ['<rootDir>/tests/mobile/**/*.test.tsx'],
    },
  ],
};
