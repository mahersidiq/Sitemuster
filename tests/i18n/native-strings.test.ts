import { describe, expect, it } from 'vitest';

import expoConfig from '../../app.config';
import en from '../../locales/native/en.json';
import es from '../../locales/native/es.json';

/** Native permission rationales are shown by the OS, outside i18next: both languages required. */
describe('native permission texts', () => {
  it('exist in English and Spanish with identical keys and translated values', () => {
    expect(Object.keys(es.ios).sort()).toEqual(Object.keys(en.ios).sort());
    for (const key of Object.keys(en.ios) as (keyof typeof en.ios)[]) {
      expect(es.ios[key]).not.toEqual(en.ios[key]);
      expect(es.ios[key].length).toBeGreaterThan(10);
    }
  });

  it('are wired into the Expo config, and the camera never asks for the microphone', () => {
    const config = expoConfig({
      config: {},
      projectRoot: process.cwd(),
      staticConfigPath: null,
      packageJsonPath: null,
    });
    expect(config.locales).toEqual({
      en: './locales/native/en.json',
      es: './locales/native/es.json',
    });
    expect(config.plugins).toContainEqual([
      'expo-camera',
      expect.objectContaining({ microphonePermission: false, recordAudioAndroid: false }),
    ]);
  });
});
