import type { ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID={testID}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
});
