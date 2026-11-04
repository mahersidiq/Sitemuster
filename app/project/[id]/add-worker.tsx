import { useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Locale } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useProject, hideOnAuthError } from '../../../src/api/hooks';
import type { WorkerDetailsInput } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { NoticeView } from '../../../src/components/NoticeView';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { ToggleRow } from '../../../src/components/ToggleRow';
import { Body, Heading, Title } from '../../../src/components/Typography';
import {
  detailsError,
  EMPTY_DETAILS,
  WorkerDetailsForm,
} from '../../../src/components/WorkerDetailsForm';
import { useApi } from '../../../src/state/auth';

export default function AddWorkerScreen() {
  return (
    <StaffGate>
      <AddWorker />
    </StaffGate>
  );
}

/**
 * Supervised onboarding for a worker without a phone (decision #1/#3): a managed profile with no
 * invented phone, e-mail or account; the supervisor reads the disclosure in the worker's language
 * and records the acknowledgement. Approval stays a separate step.
 */
function AddWorker() {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const [workerLocale, setWorkerLocale] = useState<Locale>('es-US');
  const notice = hideOnAuthError(
    useQuery({
      queryKey: ['project-notice', id, workerLocale],
      queryFn: () => api.getProjectNotice(id, workerLocale),
    }),
  );
  const roster = hideOnAuthError(
    useQuery({
      queryKey: queryKeys.roster(id),
      queryFn: () => api.listEnrollments(id),
    }),
  );
  const companies = Array.from(
    new Map(
      (roster.data ?? [])
        .filter((r) => r.company_id && r.company_name)
        .map((r) => [
          r.company_id as string,
          { id: r.company_id as string, name: r.company_name as string },
        ]),
    ).values(),
  );
  const [details, setDetails] = useState<WorkerDetailsInput>(EMPTY_DETAILS);
  const [acknowledged, setAcknowledged] = useState(false);
  const [idempotencyKey] = useState(() => randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = detailsError(details);
    if (problem) {
      setError(t(`apiErrors.${problem}`));
      return;
    }
    if (!notice.data) return;
    setBusy(true);
    setError(null);
    try {
      await api.createManagedWorker({
        ...details,
        projectId: id,
        locale: workerLocale,
        noticeVersionId: notice.data.notice.id,
        acknowledged,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster(id) });
      setDone(true);
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="add-worker-screen">
      <Title>{t('addWorker.title')}</Title>
      {project.data ? <Body>{project.data.project.name}</Body> : null}
      <Body>{t('addWorker.intro')}</Body>
      {done ? (
        <>
          <Banner tone="success" text={t('addWorker.done')} testID="add-worker-done" />
          <AppButton
            label={t('common.done')}
            onPress={() => router.back()}
            testID="add-worker-back"
          />
        </>
      ) : (
        <>
          <WorkerDetailsForm value={details} onChange={setDetails} companies={companies} />
          <Heading>{t('addWorker.noticeTitle')}</Heading>
          <ChipGroup
            label={t('addWorker.workerLanguage')}
            options={[
              { value: 'en-US' as const, label: t('language.english') },
              { value: 'es-US' as const, label: t('language.spanish') },
            ]}
            selected={[workerLocale]}
            onToggle={setWorkerLocale}
            testID="add-worker-language"
          />
          <QueryState
            isLoading={notice.isLoading}
            error={notice.error}
            onRetry={() => void notice.refetch()}
          />
          {notice.data ? (
            <NoticeView notice={notice.data.notice} acceptable={notice.data.notice_acceptable} />
          ) : null}
          <ToggleRow
            label={t('addWorker.acknowledged')}
            description={t('addWorker.acknowledgedHint')}
            value={acknowledged}
            onValueChange={setAcknowledged}
            testID="add-worker-ack"
          />
          <AppButton
            label={busy ? t('common.saving') : t('addWorker.create')}
            onPress={() => void submit()}
            disabled={busy || !acknowledged || !notice.data?.notice_acceptable}
            testID="add-worker-submit"
          />
        </>
      )}
      {error ? <Banner tone="danger" text={error} testID="add-worker-error" /> : null}
    </Screen>
  );
}
