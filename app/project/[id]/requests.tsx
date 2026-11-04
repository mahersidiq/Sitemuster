import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useCorrectionRequests, useProject } from '../../../src/api/hooks';
import type { CorrectionRequestRow } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { localDateTime } from '../../../src/fallbacks/fallbacks';
import { useApi } from '../../../src/state/auth';
import { colors } from '../../../src/theme';

export default function RequestsRoute() {
  return (
    <StaffGate>
      <Requests />
    </StaffGate>
  );
}

/**
 * Worker and foreman correction requests (docs/spec/04: proposed adjustments, the original stays
 * auditable). Approving opens the manual correction with the proposal filled in: the change and
 * the approval are saved together by the server. Rejecting needs a reason the worker can read.
 */
function Requests() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const requests = useCorrectionRequests(id);
  const { refetch } = requests;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const zone = project.data?.project.iana_timezone ?? 'UTC';
  const pending = requests.data?.filter((r) => r.status === 'PENDING') ?? [];
  const decided = requests.data?.filter((r) => r.status !== 'PENDING') ?? [];
  return (
    <Screen testID="requests-screen">
      <Title>{t('requests.title')}</Title>
      <Body>{t('requests.intro')}</Body>
      <QueryState
        isLoading={requests.isLoading}
        error={requests.error}
        onRetry={() => void requests.refetch()}
      />
      {requests.data && pending.length === 0 ? <Body>{t('requests.nonePending')}</Body> : null}
      {pending.map((request) => (
        <RequestCard key={request.request_id} request={request} projectId={id} zone={zone} />
      ))}
      {decided.length > 0 ? <Heading>{t('requests.decided')}</Heading> : null}
      {decided.map((request) => (
        <RequestCard key={request.request_id} request={request} projectId={id} zone={zone} />
      ))}
    </Screen>
  );
}

function when(value: string | null | undefined, zone: string): string | null {
  if (!value) return null;
  const local = localDateTime(value, zone);
  return `${local.date} ${local.time}`;
}

function RequestCard({
  request,
  projectId,
  zone,
}: {
  request: CorrectionRequestRow;
  projectId: string;
  zone: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const original = [when(request.original.start_at, zone), when(request.original.end_at, zone)]
    .filter(Boolean)
    .join(' – ');
  const proposed = [
    when(request.proposed.proposed_start_at, zone),
    when(request.proposed.proposed_end_at, zone),
  ]
    .filter(Boolean)
    .join(' – ');
  const reject = async () => {
    if (reason.trim().length < 3) {
      setError(t('requests.reasonNeeded'));
      return;
    }
    setError(null);
    try {
      await api.rejectCorrectionRequest(request.request_id, reason.trim());
      setRejecting(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.correctionRequests(projectId) });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };
  return (
    <Card testID={`request-${request.request_id}`}>
      <Heading>{request.worker_name}</Heading>
      <Text style={styles.meta}>
        {[t(`requests.channel.${request.channel}`), request.company_name]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {original ? (
        <Text style={styles.line}>{t('requests.original', { times: original })}</Text>
      ) : null}
      <Text style={styles.line}>{t('requests.proposed', { times: proposed || '—' })}</Text>
      <Text style={styles.line}>{t('requests.reason', { reason: request.reason })}</Text>
      {request.status !== 'PENDING' ? (
        <Banner
          tone={request.status === 'APPROVED' ? 'success' : 'warning'}
          text={
            request.status === 'APPROVED'
              ? t('requests.approved')
              : t('requests.rejected', { reason: request.decision_reason ?? '' })
          }
          testID={`request-status-${request.request_id}`}
        />
      ) : rejecting ? (
        <>
          <TextField
            label={t('requests.rejectReason')}
            value={reason}
            onChangeText={setReason}
            maxLength={1000}
            error={error}
            testID={`reject-reason-${request.request_id}`}
          />
          <AppButton
            label={t('requests.rejectConfirm')}
            onPress={() => void reject()}
            testID={`reject-confirm-${request.request_id}`}
          />
        </>
      ) : (
        <>
          <AppButton
            label={t('requests.approve')}
            onPress={() =>
              router.push({
                pathname: '/project/[id]/correct',
                params: {
                  id: projectId,
                  workerId: request.worker_id,
                  name: request.worker_name,
                  requestId: request.request_id,
                  sessionId: request.session_id ?? '',
                  proposedStart: request.proposed.proposed_start_at ?? '',
                  proposedEnd: request.proposed.proposed_end_at ?? '',
                },
              })
            }
            testID={`approve-${request.request_id}`}
          />
          <AppButton
            variant="secondary"
            label={t('requests.reject')}
            onPress={() => setRejecting(true)}
            testID={`reject-${request.request_id}`}
          />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  meta: { fontSize: 14, color: colors.mutedText },
  line: { fontSize: 16, color: colors.text },
});
