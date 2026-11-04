// ESLint flat config: Expo base rules + SiteMuster banned patterns (CLAUDE.md).
import expoConfig from 'eslint-config-expo/flat.js';
import prettierConfig from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';

const bannedGlobals = [
  {
    name: 'localStorage',
    message: 'Banned (CLAUDE.md): use expo-secure-store / encrypted expo-sqlite.',
  },
  {
    name: 'sessionStorage',
    message: 'Banned (CLAUDE.md): use expo-secure-store / encrypted expo-sqlite.',
  },
];

const bannedProperties = [
  { object: 'window', property: 'localStorage', message: 'Banned browser storage API.' },
  { object: 'window', property: 'sessionStorage', message: 'Banned browser storage API.' },
  {
    object: 'navigator',
    property: 'geolocation',
    message: 'Banned browser location API; use the native engine.',
  },
];

const bannedImports = {
  paths: [
    {
      name: 'expo-location',
      message:
        'Decision #12: Transistorsoft v5 is the location engine; expo-location is not the tracker.',
    },
    {
      name: 'expo-print',
      message: 'expo-print is reserved for V1.1 advanced PDFs and is not installed in V1.',
    },
  ],
};

export default [
  ...expoConfig,
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      'dist/**',
      'coverage/**',
      'ios/**',
      'android/**',
      'supabase/.temp/**',
      'babel.config.js',
      'jest.config.js',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals],
      'no-restricted-properties': ['error', ...bannedProperties],
      'no-restricted-imports': ['error', bannedImports],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // User-facing React Native code must not contain hardcoded copy (docs/spec/08-i18n.md).
    files: ['app/**/*.tsx', 'src/**/*.tsx'],
    ignores: ['**/*.test.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
    },
  },
  {
    files: ['scripts/**/*.{ts,mjs,js}', 'tools/**/*.{cjs,mjs,js}'],
    rules: { 'no-console': 'off' },
  },
  {
    // UI-preview shims are copied into the app tree only inside the throw-away preview copy.
    files: ['tools/ui-preview/shims/**/*.{ts,tsx}'],
    rules: { 'import/no-unresolved': 'off' },
  },
  prettierConfig,
];
