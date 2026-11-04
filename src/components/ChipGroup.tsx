import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, minTouchTarget, spacing } from '../theme';

export interface ChipOption<T extends string | number> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

/** Wrapping chips: single choice (radio semantics) or multiple choice (checkbox semantics). */
export function ChipGroup<T extends string | number>({
  options,
  selected,
  onToggle,
  multiple = false,
  label,
  testID,
}: {
  options: readonly ChipOption<T>[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  multiple?: boolean;
  label: string;
  testID?: string;
}) {
  return (
    <View style={styles.group} accessibilityLabel={label} testID={testID}>
      {options.map((option) => {
        const isSelected = selected.includes(option.value);
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={multiple ? 'checkbox' : 'radio'}
            accessibilityState={multiple ? { checked: isSelected } : { selected: isSelected }}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            onPress={() => onToggle(option.value)}
            style={[styles.chip, isSelected && styles.chipSelected]}
            testID={testID ? `${testID}-${String(option.value)}` : undefined}
          >
            <Text style={[styles.chipText, isSelected && styles.chipTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.sm,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 16, color: colors.text, fontWeight: '600' },
  chipTextSelected: { color: colors.onPrimary },
});
