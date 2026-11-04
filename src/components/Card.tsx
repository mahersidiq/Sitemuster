import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme';

/** Grouping surface; pressable when `onPress` is given (announced as a button). */
export function Card({
  children,
  onPress,
  accessibilityLabel,
  testID,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  if (!onPress) {
    return (
      <View style={styles.card} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  pressed: { opacity: 0.85 },
});
