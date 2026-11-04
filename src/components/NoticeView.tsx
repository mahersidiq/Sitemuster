import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { Notice } from '../api/types';
import { colors, spacing } from '../theme';
import { Banner } from './Banner';

/**
 * Shows the project's location disclosure exactly as stored (versioned, hashed). Draft legal text
 * is visibly labelled; when the backend says it cannot be accepted (production + not approved),
 * the screen says so instead of pretending.
 */
export function NoticeView({ notice, acceptable }: { notice: Notice; acceptable: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="notice-view">
      {notice.review_status !== 'APPROVED' ? (
        <Banner text={t('notice.draftWatermark')} testID="notice-draft" />
      ) : null}
      {!acceptable ? (
        <Banner tone="danger" text={t('notice.notApproved')} testID="notice-blocked" />
      ) : null}
      <View style={styles.paper}>
        <Text style={styles.body} testID="notice-content">
          {notice.content}
        </Text>
      </View>
      <Text style={styles.meta}>
        {t('notice.versionLine', { id: notice.document_id, version: notice.version })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  paper: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  meta: { fontSize: 13, color: colors.mutedText },
});
