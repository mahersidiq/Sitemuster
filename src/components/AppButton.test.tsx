import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AppButton } from './AppButton';

describe('AppButton', () => {
  it('is an accessible button that fires onPress', async () => {
    const onPress = jest.fn();
    await render(<AppButton label="Continuar" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Continuar' });
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('announces and enforces the disabled state (no fake success)', async () => {
    const onPress = jest.fn();
    await render(<AppButton label="Sign in with phone" onPress={onPress} disabled />);
    const button = screen.getByRole('button', { name: 'Sign in with phone' });
    expect(button.props.accessibilityState).toEqual({ disabled: true });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
