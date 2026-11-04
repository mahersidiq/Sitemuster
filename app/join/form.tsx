import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../src/api/errors';
import { queryKeys } from '../../src/api/hooks';
import type { WorkerDetailsInput } from '../../src/api/types';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { LoadingScreen } from '../../src/components/LoadingScreen';
import { NoticeView } from '../../src/components/NoticeView';
import { QueryState } from '../../src/components/QueryState';
import { Screen } from '../../src/components/Screen';
import { ToggleRow } from '../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../src/components/Typography';
import {
  detailsError,
  EMPTY_DETAILS,
  WorkerDetailsForm,
} from '../../src/components/WorkerDetailsForm';
import { formatInstant } from '../../src/projects/format';
import { useAuth } from '../../src/state/auth';
import { useLanguage } from '../../src/state/language';
import { colors } from '../../src/theme';

type Step = 'details' | 'notice' | 'done';

/**
 * Worker orientation: project details → disclosure (in the chosen language) → done. Completing
 * records ORIENTATION_COMPLETED and a PENDING enrollment; approval and employer confirmation are
 * separate staff actions (decision #4).
 */
export default function JoinFormScreen() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in') return <Redirect href="/" />;
  return <JoinForm />;
}

function JoinForm() {
  const { t } = useTranslation();
  const { api, refresh } = useAuth();
  const { activeLocale } = useLanguage();
  const queryClient = useQueryClient();
  const { code } = useLocalSearchParams<{ code: string }>();
  const preview = useQuery({
    queryKey: ['orientation-preview', code, activeLocale],
    queryFn: () => {
      if (!api) throw new Error('no api');
      return api.previewOrientation(code, activeLocale);
    },
    retry: false,
  });
  const [step, setStep] = useState<Step>('details');
  const [details, setDetails] = useState<WorkerDetailsInput>(EMPTY_DETAILS);
  const [prefilled, setPrefilled] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = preview.data;

  if (data && !prefilled) {
    setPrefilled(true);
    if (data.profile) setDetails((d) => ({ ...d, legalName: data.profile?.legal_name ?? '' }));
  }

  const next = () => {
    const problem = detailsError(details);
    if (problem) {
      setError(t(`apiErrors.${problem}`));
      return;
    }
    setError(null);
    setStep('notice');
  };

  const submit = async () => {
    if (!api || !data) return;
    setBusy(true);
    setError(null);
    try {
      await api.completeOrientation({
        ...details,
        code,
        locale: activeLocale,
        noticeVersionId: data.notice.id,
        accept: accepted,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.myEnrollments });
      await refresh();
      setStep('done');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="join-form-screen">
      <Title>{t('join.formTitle')}</Title>
      <QueryState
        isLoading={preview.isLoading}
        error={preview.error}
        onRetry={() => void preview.refetch()}
      />
      {data ? (
        <Card testID="join-project">
          <Heading>{data.project_name}</Heading>
          <Text style={styles.hint}>{data.organization_name}</Text>
          <Text style={styles.hint}>
            {t('join.sessionUntil', {
              time: formatInstant(data.session_expires_at, undefined, activeLocale),
            })}
          </Text>
          {data.existing_enrollment ? (
            <Text style={styles.hint}>
              {t(`enrollmentStatus.${data.existing_enrollment.enrollment_status}`)}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {data && step === 'details' ? (
        <>
          <WorkerDetailsForm value={details} onChange={setDetails} companies={data.companies} />
          <AppButton label={t('common.next')} onPress={next} testID="join-next" />
        </>
      ) : null}

      {data && step === 'notice' ? (
        <>
          <Heading>{t('join.noticeTitle')}</Heading>
          <Body>{t('join.noticeIntro')}</Body>
          <NoticeView notice={data.notice} acceptable={data.notice_acceptable} />
          <ToggleRow
            label={t('join.acknowledge')}
            value={accepted}
            onValueChange={setAccepted}
            testID="join-acknowledge"
          />
          <AppButton
            label={busy ? t('common.saving') : t('join.acceptAndJoin')}
            onPress={() => void submit()}
            disabled={busy || !accepted || !data.notice_acceptable}
            testID="join-submit"
          />
          <AppButton
            variant="secondary"
            label={t('join.decline')}
            onPress={() => {
              setAccepted(false);
              setError(t('join.declined'));
            }}
            disabled={busy}
            testID="join-decline"
          />
          <AppButton
            variant="secondary"
            label={t('common.back')}
            onPress={() => setStep('details')}
            disabled={busy}
          />
        </>
      ) : null}

      {step === 'done' ? (
        <>
          <Banner tone="success" text={t('join.doneTitle')} testID="join-done" />
          <Body>{t('join.doneBody')}</Body>
          <AppButton
            label={t('join.goHome')}
            onPress={() => router.replace('/')}
            testID="join-home"
          />
        </>
      ) : null}

      {error ? <Banner tone="danger" text={error} testID="join-error" /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, color: colors.mutedText },
});
