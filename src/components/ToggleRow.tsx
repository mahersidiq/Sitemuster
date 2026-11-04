import { StyleSheet, Switch, Text, View } from 'react-native';

import { colors, minTouchTarget, spacing } from '../theme';

/** Labelled switch with an optional explanation (the label is the accessible name). */
export function ToggleRow({
  label,
  description,
  value,
  onValueChange,
  testID,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={description}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: colors.primary, false: colors.border }}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  text: { flex: 1, gap: 2 },
  label: { fontSize: 17, fontWeight: '600', color: colors.text },
  description: { fontSize: 15, color: colors.mutedText },
});
