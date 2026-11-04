import { describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';

import { LanguageProvider } from '../state/language';
import { LanguageSwitcher } from './LanguageSwitcher';

describe('LanguageSwitcher', () => {
  it('switches the UI to Spanish and persists the choice on-device', async () => {
    await render(
      <LanguageProvider appEnv="development">
        <LanguageSwitcher />
      </LanguageProvider>,
    );
    expect(await screen.findByText('Current language: English')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('language-switch-es-US'));

    expect(await screen.findByText('Idioma actual: Español')).toBeTruthy();
    expect(screen.getByText('Idioma')).toBeTruthy();
    await waitFor(async () => {
      expect(await SecureStore.getItemAsync('sitemuster.locale.v1')).toBe('es-US');
    });
  });

  it('exposes localized accessibility labels for each language button', async () => {
    await render(
      <LanguageProvider appEnv="production">
        <LanguageSwitcher />
      </LanguageProvider>,
    );
    expect(await screen.findByLabelText('Use Español')).toBeTruthy();
    expect(screen.getByLabelText('Use English')).toBeTruthy();
  });
});
