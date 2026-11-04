import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../src/api/errors';
import { queryKeys, useMyConsents } from '../src/api/hooks';
import { AppButton } from '../src/components/AppButton';
import { Banner } from '../src/components/Banner';
import { Card } from '../src/components/Card';
import { LoadingScreen } from '../src/components/LoadingScreen';
import { NoticeView } from '../src/components/NoticeView';
import { QueryState } from '../src/components/QueryState';
import { Screen } from '../src/components/Screen';
import { ToggleRow } from '../src/components/ToggleRow';
import { Body, Heading, Title } from '../src/components/Typography';
import { formatInstant } from '../src/projects/format';
import { useApi, useAuth } from '../src/state/auth';
import { useTracking } from '../src/state/tracking';
import { colors } from '../src/theme';

export default function PrivacyRoute() {
  const { state, api } = useAuth();
  if (api && state.status === 'loading') return <LoadingScreen />;
  if (!api || state.status !== 'signed_in' || !state.access.worker_profile_id) {
    return <Redirect href="/" />;
  }
  return <Privacy />;
}

/**
 * The worker's location permission per project (spec 09: withdraw at any time). Off stops the
 * phone's location for that project at once; the kiosk and the foreman still work. When the site
 * notice changed materially, the new text must be accepted before location resumes.
 */
function Privacy() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const tracking = useTracking();
  const consents = useMyConsents();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const after = async (text: string) => {
    setMessage({ tone: 'success', text });
    await queryClient.invalidateQueries({ queryKey: queryKeys.myConsents });
    await tracking.refresh();
  };

  const change = async (projectId: string, enabled: boolean) => {
    setBusy(projectId);
    setMessage(null);
    try {
      await api.setLocationConsent(projectId, enabled);
      await after(enabled ? t('privacy.turnedOn') : t('privacy.turnedOff'));
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    } finally {
      setBusy(null);
    }
  };

  const renew = async (projectId: string, noticeId: string) => {
    setBusy(projectId);
    setMessage(null);
    try {
      await api.renewConsent(projectId, noticeId);
      await after(t('privacy.renewed'));
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen testID="privacy-screen">
      <Title>{t('privacy.title')}</Title>
      <Body>{t('privacy.intro')}</Body>
      <QueryState
        isLoading={consents.isLoading}
        error={consents.error}
        onRetry={() => void consents.refetch()}
      />
      {consents.data && consents.data.length === 0 ? <Body>{t('privacy.none')}</Body> : null}
      {consents.data?.map((consent) => (
        <Card key={consent.project_id} testID={`privacy-${consent.project_id}`}>
          <Heading>{consent.project_name}</Heading>
          {consent.renewal_required && consent.renewal_notice ? (
            <>
              <Banner
                tone="warning"
                text={t('privacy.renewalNeeded')}
                testID={`privacy-renewal-${consent.project_id}`}
              />
              <NoticeView notice={consent.renewal_notice} acceptable />
              <AppButton
                label={t('privacy.accept')}
                onPress={() => void renew(consent.project_id, consent.renewal_notice?.id ?? '')}
                disabled={busy === consent.project_id}
                testID={`privacy-accept-${consent.project_id}`}
              />
            </>
          ) : (
            <ToggleRow
              label={t('privacy.location')}
              description={
                consent.location_enabled
                  ? t('privacy.locationOnHelp')
                  : t('privacy.locationOffHelp')
              }
              value={consent.location_enabled}
              onValueChange={(value) => void change(consent.project_id, value)}
              testID={`privacy-location-${consent.project_id}`}
            />
          )}
          <Text style={styles.hint}>
            {t('privacy.accepted', {
              version: consent.notice_version,
              date: formatInstant(consent.accepted_at, undefined, i18n.language),
            })}
          </Text>
        </Card>
      ))}
      {message ? <Banner tone={message.tone} text={message.text} testID="privacy-message" /> : null}
      <AppButton
        variant="secondary"
        label={t('account.delete.open')}
        onPress={() => router.push('/account/delete')}
        testID="privacy-delete-account"
      />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="privacy-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({ hint: { fontSize: 15, color: colors.mutedText } });
