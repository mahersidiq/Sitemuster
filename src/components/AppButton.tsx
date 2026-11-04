import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, minTouchTarget, spacing } from '../theme';

interface AppButtonProps {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function AppButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
  accessibilityLabel,
  accessibilityHint,
  testID,
}: AppButtonProps) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : styles.secondary,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.label, primary ? styles.primaryLabel : styles.secondaryLabel]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: minTouchTarget,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  label: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  primaryLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.text },
});
