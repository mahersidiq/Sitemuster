import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { ProjectStatus } from '@sitemuster/shared';

import { colors, spacing } from '../theme';

const tone: Record<ProjectStatus, { backgroundColor: string; color: string }> = {
  DRAFT: { backgroundColor: colors.warningBackground, color: colors.warningText },
  ACTIVE: { backgroundColor: colors.successBackground, color: colors.successText },
  PAUSED: { backgroundColor: colors.warningBackground, color: colors.warningText },
  COMPLETED: { backgroundColor: colors.infoBackground, color: colors.infoText },
  ARCHIVED: { backgroundColor: colors.surface, color: colors.mutedText },
};

export function StatusPill({ status, testID }: { status: ProjectStatus; testID?: string }) {
  const { t } = useTranslation();
  const colorsFor = tone[status];
  return (
    <View style={[styles.pill, { backgroundColor: colorsFor.backgroundColor }]} testID={testID}>
      <Text style={[styles.text, { color: colorsFor.color }]}>{t(`projectStatus.${status}`)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  text: { fontSize: 14, fontWeight: '700' },
});
