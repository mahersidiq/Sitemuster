import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../../../src/api/errors';
import { useOpenVisits, useProject } from '../../../src/api/hooks';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { Screen } from '../../../src/components/Screen';
import { StaffGate } from '../../../src/components/StaffGate';
import { SyncStatusCard } from '../../../src/components/SyncStatusCard';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { OutcomeLine } from '../../../src/fallbacks/OutcomeLine';
import { useOutbox } from '../../../src/state/outbox';
import { colors, spacing } from '../../../src/theme';

export default function VisitorsRoute() {
  return (
    <StaffGate>
      <Visitors />
    </StaffGate>
  );
}

interface OnSite {
  visitorId: string;
  name: string;
  organization: string | null;
  hostUserId: string | null;
  purpose: string;
  since: string;
  unresolved: boolean;
  waiting: boolean;
}

/**
 * Visitor desk (docs/spec/01: visitors, inspectors, deliveries): sign in and out at the attended
 * kiosk, never counted as workforce. A new visitor gets an id on this phone, so they can be signed
 * out even while offline (decision #101).
 */
function Visitors() {
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  const visits = useOpenVisits(id);
  const outbox = useOutbox();
  const [name, setName] = useState('');
  const [organization, setOrganization] = useState('');
  const [purpose, setPurpose] = useState('');
  const [host, setHost] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staff = project.data?.staff ?? [];

  const mine = useMemo(
    () =>
      outbox.entries.filter(
        (entry) =>
          entry.event.project_id === id &&
          (entry.event.operation_type === 'VISITOR_ENTRY' ||
            entry.event.operation_type === 'VISITOR_EXIT'),
      ),
    [outbox.entries, id],
  );

  // Server visits plus sign-ins still on this phone, minus sign-outs still on this phone.
  const onSite = useMemo<OnSite[]>(() => {
    const out = new Map<string, OnSite>();
    for (const visit of visits.data ?? []) {
      out.set(visit.visitor_id, {
        visitorId: visit.visitor_id,
        name: visit.name,
        organization: visit.organization,
        hostUserId: visit.host_user_id,
        purpose: visit.purpose,
        since: visit.checked_in_at,
        unresolved: visit.status === 'UNRESOLVED',
        waiting: false,
      });
    }
    for (const entry of mine) {
      const event = entry.event;
      if (event.operation_type === 'VISITOR_ENTRY' && entry.status === 'PENDING') {
        const payload = event.payload;
        if (payload.visitor_id && !out.has(payload.visitor_id)) {
          out.set(payload.visitor_id, {
            visitorId: payload.visitor_id,
            name: payload.name ?? '',
            organization: payload.organization ?? null,
            hostUserId: payload.host_user_id,
            purpose: payload.purpose,
            since: event.observed_at,
            unresolved: false,
            waiting: true,
          });
        }
      }
      if (event.operation_type === 'VISITOR_EXIT' && entry.status === 'PENDING') {
        if (event.payload.visitor_id) out.delete(event.payload.visitor_id);
      }
    }
    return [...out.values()];
  }, [visits.data, mine]);

  const signIn = async () => {
    setError(null);
    if (!name.trim() || !purpose.trim() || !host) {
      setError(t('visitors.required'));
      return;
    }
    try {
      await outbox.enqueue(
        {
          project_id: id,
          operation_type: 'VISITOR_ENTRY',
          observed_at: new Date().toISOString(),
          payload: {
            visitor_id: Crypto.randomUUID(),
            name: name.trim(),
            ...(organization.trim() ? { organization: organization.trim() } : {}),
            host_user_id: host,
            purpose: purpose.trim(),
            direction: 'ENTRY',
          },
        },
        { title: name.trim() },
      );
      setName('');
      setOrganization('');
      setPurpose('');
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  const signOut = async (visit: OnSite) => {
    setError(null);
    try {
      await outbox.enqueue(
        {
          project_id: id,
          operation_type: 'VISITOR_EXIT',
          observed_at: new Date().toISOString(),
          payload: {
            visitor_id: visit.visitorId,
            host_user_id: visit.hostUserId ?? host ?? staff[0]?.user_id ?? '',
            purpose: visit.purpose,
            direction: 'EXIT',
          },
        },
        { title: visit.name },
      );
      void visits.refetch();
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const settled = mine.filter((entry) => entry.status !== 'PENDING').reverse();

  return (
    <Screen testID="visitors-screen">
      <Title>{t('visitors.title')}</Title>
      {project.data ? <Body>{project.data.project.name}</Body> : null}
      <Banner tone="info" text={t('visitors.separate')} />
      <Card testID="visitor-sign-in">
        <Heading>{t('visitors.signIn')}</Heading>
        <TextField
          label={t('visitors.name')}
          value={name}
          onChangeText={setName}
          maxLength={200}
          testID="visitor-name"
        />
        <TextField
          label={t('visitors.organization')}
          value={organization}
          onChangeText={setOrganization}
          maxLength={200}
          testID="visitor-organization"
        />
        <TextField
          label={t('visitors.purpose')}
          value={purpose}
          onChangeText={setPurpose}
          maxLength={500}
          testID="visitor-purpose"
        />
        <Text style={styles.label}>{t('visitors.host')}</Text>
        <ChipGroup
          label={t('visitors.host')}
          options={staff.map((member) => ({
            value: member.user_id,
            label: `${member.email ?? member.user_id.slice(0, 8)} · ${t(`roles.${member.role}`)}`,
          }))}
          selected={host ? [host] : []}
          onToggle={setHost}
          testID="visitor-host"
        />
        <AppButton
          label={t('visitors.submit')}
          onPress={() => void signIn()}
          testID="visitor-submit"
        />
      </Card>
      {error ? <Banner tone="danger" text={error} testID="visitors-error" /> : null}
      <Card testID="visitors-on-site">
        <Heading>{t('visitors.onSite')}</Heading>
        {onSite.length === 0 ? <Text style={styles.hint}>{t('visitors.none')}</Text> : null}
        {onSite.map((visit) => (
          <View key={visit.visitorId} style={styles.row} testID={`visitor-${visit.visitorId}`}>
            <Text style={styles.line}>
              {[visit.name, visit.organization].filter(Boolean).join(' · ')}
            </Text>
            <Text style={styles.hint}>
              {`${visit.purpose} · ${t('visitors.since', { time: time(visit.since) })}`}
            </Text>
            {visit.unresolved ? (
              <Text style={styles.warning}>{t('visitors.unresolved')}</Text>
            ) : null}
            {visit.waiting ? <Text style={styles.warning}>{t('visitors.waiting')}</Text> : null}
            <AppButton
              variant="secondary"
              label={t('visitors.signOut')}
              onPress={() => void signOut(visit)}
              testID={`visitor-sign-out-${visit.visitorId}`}
            />
          </View>
        ))}
      </Card>
      {settled.length > 0 ? (
        <Card testID="visitor-results">
          {settled.map((entry) => (
            <View key={entry.event.event_uuid} style={styles.row}>
              <Text style={styles.line}>{entry.label.title}</Text>
              <OutcomeLine entry={entry} />
            </View>
          ))}
        </Card>
      ) : null}
      <SyncStatusCard />
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="visitors-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  line: { fontSize: 16, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  warning: { fontSize: 15, color: colors.warningText, fontWeight: '600' },
  row: { paddingVertical: spacing.xs, gap: spacing.xs },
});
