import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

export function Banner({
  text,
  tone = 'warning',
  testID,
}: {
  text: string;
  tone?: 'warning' | 'danger';
  testID?: string;
}) {
  return (
    <View
      accessibilityRole="alert"
      style={[styles.base, tone === 'danger' ? styles.danger : styles.warning]}
      testID={testID}
    >
      <Text style={tone === 'danger' ? styles.dangerText : styles.warningText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: 8, padding: spacing.sm },
  warning: { backgroundColor: colors.warningBackground },
  danger: { backgroundColor: colors.dangerBackground },
  warningText: { color: colors.warningText, fontSize: 15 },
  dangerText: { color: colors.dangerText, fontSize: 15 },
});
