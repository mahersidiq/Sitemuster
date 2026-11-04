import { StyleSheet, Text, type ColorValue } from 'react-native';

import { colors } from '../theme';

/**
 * Text-only tab bar that never truncates longer Spanish labels (docs/spec/08-i18n.md):
 * labels may wrap to two lines instead of being cut off.
 */
export function tabScreenOptions(title: string) {
  return {
    title,
    tabBarIcon: () => null,
    tabBarIconStyle: styles.hiddenIcon,
    tabBarLabel: ({ color }: { color: ColorValue }) => (
      <Text
        numberOfLines={2}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
        style={[styles.label, { color }]}
      >
        {title}
      </Text>
    ),
  };
}

export const tabNavigatorOptions = {
  tabBarActiveTintColor: colors.primary,
  tabBarInactiveTintColor: colors.mutedText,
  tabBarStyle: { minHeight: 64 },
  headerTitleAlign: 'center' as const,
};

const styles = StyleSheet.create({
  hiddenIcon: { display: 'none' },
  label: { fontSize: 12, fontWeight: '600', textAlign: 'center', paddingHorizontal: 1 },
});
