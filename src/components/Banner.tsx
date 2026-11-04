import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

export function Banner({
  text,
  tone = 'warning',
  testID,
}: {
  text: string;
  tone?: 'warning' | 'danger' | 'info' | 'success';
  testID?: string;
}) {
  return (
    <View
      accessibilityRole={tone === 'info' || tone === 'success' ? 'text' : 'alert'}
      style={[styles.base, styles[tone]]}
      testID={testID}
    >
      <Text style={styles[`${tone}Text`]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: 8, padding: spacing.sm },
  warning: { backgroundColor: colors.warningBackground },
  danger: { backgroundColor: colors.dangerBackground },
  warningText: { color: colors.warningText, fontSize: 15 },
  dangerText: { color: colors.dangerText, fontSize: 15 },
  info: { backgroundColor: colors.infoBackground },
  infoText: { color: colors.infoText, fontSize: 15 },
  success: { backgroundColor: colors.successBackground },
  successText: { color: colors.successText, fontSize: 15 },
});
