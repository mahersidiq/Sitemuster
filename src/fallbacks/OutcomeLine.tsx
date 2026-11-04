import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { OutboxEntry } from '../outbox/outbox';
import { colors } from '../theme';
import { outcomeOf } from './fallbacks';

/** The localized reason a record was refused (generic text for codes the app does not know). */
export function useReasonText(): (reason: string | null) => string {
  const { t, i18n } = useTranslation();
  return (reason) => {
    const key = `operationReason.${reason ?? 'other'}`;
    return i18n.exists(key) ? t(key) : t('operationReason.other');
  };
}

/**
 * One record's state as the person sees it: "waiting to sync" until the server answers, then
 * recorded (with the worker's name for a scan, and a review note) or not recorded with why.
 */
export function OutcomeLine({
  entry,
  nameOf,
  testID,
}: {
  entry: OutboxEntry;
  nameOf?: (workerId: string) => string | null;
  testID?: string;
}) {
  const { t } = useTranslation();
  const reasonText = useReasonText();
  const outcome = outcomeOf(entry);
  if (outcome.kind === 'PENDING') {
    return (
      <Text style={[styles.text, styles.pending]} testID={testID}>
        {t('outbox.status.PENDING')}
      </Text>
    );
  }
  if (outcome.kind === 'REJECTED') {
    return (
      <Text style={[styles.text, styles.rejected]} testID={testID}>
        {`${t('outbox.status.REJECTED')}: ${reasonText(outcome.reason)}`}
      </Text>
    );
  }
  const name = outcome.workerId ? (nameOf?.(outcome.workerId) ?? null) : null;
  return (
    <Text style={[styles.text, styles.accepted]} testID={testID}>
      {name ? t('outbox.acceptedFor', { name }) : t('outbox.status.ACCEPTED')}
      {outcome.review ? ` · ${t('outbox.review')}` : ''}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 15, fontWeight: '600' },
  pending: { color: colors.warningText },
  rejected: { color: colors.dangerText },
  accepted: { color: colors.successText },
});
