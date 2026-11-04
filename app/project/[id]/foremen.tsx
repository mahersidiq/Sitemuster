import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useKioskGrants } from '../../../src/api/hooks';
import type { ForemanKioskGrant } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Card } from '../../../src/components/Card';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { useApi } from '../../../src/state/auth';
import { colors } from '../../../src/theme';

export default function ForemenRoute() {
  return (
    <StaffGate>
      <Foremen />
    </StaffGate>
  );
}

/**
 * Kiosk access for subcontractor foremen (role matrix: "own crew if kiosk role delegated";
 * decision #107). A granted foreman scans only their own crew; every change needs a reason and is
 * audited by the server.
 */
function Foremen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const grants = useKioskGrants(id);
  return (
    <Screen testID="foremen-screen">
      <Title>{t('kioskGrants.title')}</Title>
      <Body>{t('kioskGrants.intro')}</Body>
      <QueryState
        isLoading={grants.isLoading}
        error={grants.error}
        onRetry={() => void grants.refetch()}
      />
      {grants.data && grants.data.length === 0 ? <Body>{t('kioskGrants.none')}</Body> : null}
      {grants.data?.map((grant) => (
        <GrantCard
          key={`${grant.company_id}|${grant.foreman_profile_id}`}
          projectId={id}
          grant={grant}
        />
      ))}
    </Screen>
  );
}

function GrantCard({ projectId, grant }: { projectId: string; grant: ForemanKioskGrant }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (reason.trim().length < 3) {
      setError(t('kioskGrants.reasonNeeded'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setForemanKioskGrant({
        projectId,
        companyId: grant.company_id,
        foremanProfileId: grant.foreman_profile_id,
        enabled: !grant.can_operate_kiosk,
        reason: reason.trim(),
      });
      setReason('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.kioskGrants(projectId) });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card testID={`grant-${grant.foreman_profile_id}`}>
      <Heading>{grant.name}</Heading>
      <Text style={styles.meta}>{grant.company_name}</Text>
      <Text style={styles.state} testID={`grant-state-${grant.foreman_profile_id}`}>
        {grant.can_operate_kiosk ? t('kioskGrants.allowed') : t('kioskGrants.notAllowed')}
      </Text>
      <TextField
        label={t('kioskGrants.reason')}
        value={reason}
        onChangeText={setReason}
        maxLength={500}
        error={error}
        testID={`grant-reason-${grant.foreman_profile_id}`}
      />
      <AppButton
        variant={grant.can_operate_kiosk ? 'secondary' : 'primary'}
        label={grant.can_operate_kiosk ? t('kioskGrants.remove') : t('kioskGrants.allow')}
        onPress={() => void change()}
        disabled={busy}
        testID={`grant-toggle-${grant.foreman_profile_id}`}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  meta: { fontSize: 14, color: colors.mutedText },
  state: { fontSize: 16, color: colors.text, fontWeight: '600' },
});
