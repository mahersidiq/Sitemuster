import { useQueryClient } from '@tanstack/react-query';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { ProjectStatus } from '@sitemuster/shared';

import { errorMessageKey } from '../../../src/api/errors';
import { queryKeys, useProject } from '../../../src/api/hooks';
import type { ProjectDetail } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { QueryState } from '../../../src/components/QueryState';
import { Screen } from '../../../src/components/Screen';
import { SiteMap } from '../../../src/components/SiteMap';
import { StaffGate } from '../../../src/components/StaffGate';
import { StatusPill } from '../../../src/components/StatusPill';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { describeBlocks } from '../../../src/projects/describe';
import { formatInstant, formatNowInZone, metersToFeet } from '../../../src/projects/format';
import { isClosed, NEXT_STATUSES, STATUSES_NEEDING_REASON } from '../../../src/projects/lifecycle';
import { blocksFromWindows } from '../../../src/projects/shifts';
import { useApi } from '../../../src/state/auth';
import { useLanguage } from '../../../src/state/language';
import { colors, spacing } from '../../../src/theme';

export default function ProjectDetailScreen() {
  return (
    <StaffGate>
      <ProjectDetailBody />
    </StaffGate>
  );
}

function ProjectDetailBody() {
  const { t } = useTranslation();
  const { id, created } = useLocalSearchParams<{ id: string; created?: string }>();
  const project = useProject(id);
  const { refetch } = project;
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const data = project.data;
  return (
    <Screen testID="project-detail-screen">
      <QueryState
        isLoading={project.isLoading}
        error={project.error}
        onRetry={() => void project.refetch()}
      />
      {data ? (
        <>
          {created === '1' ? (
            <Banner tone="success" text={t('project.createdBanner')} testID="project-created" />
          ) : null}
          <Title>{data.project.name}</Title>
          <StatusPill status={data.project.status} testID="project-status" />
          <Body>{t(`projectStatusHelp.${data.project.status}`)}</Body>
          {data.project.project_number ? (
            <Text style={styles.hint}>
              {t('projects.number', { number: data.project.project_number })}
            </Text>
          ) : null}
          <WorkforceCard detail={data} />
          <SiteCard detail={data} />
          <ScheduleCard detail={data} />
          <HistoryCard detail={data} />
          <LifecycleCard detail={data} />
          <StaffCard detail={data} />
        </>
      ) : null}
      <AppButton
        variant="secondary"
        label={t('project.backToProjects')}
        onPress={() => router.replace('/staff/projects')}
        testID="project-back"
      />
    </Screen>
  );
}

function WorkforceCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { permissions, project } = detail;
  if (
    !permissions.can_view_roster &&
    !permissions.can_run_orientation &&
    !permissions.can_operate_kiosk
  ) {
    return null;
  }
  return (
    <Card testID="workforce-card">
      <Heading>{t('project.workforceTitle')}</Heading>
      {permissions.can_run_orientation && project.status === 'ACTIVE' ? (
        <AppButton
          label={t('project.runOrientation')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/orientation', params: { id: project.id } })
          }
          testID="run-orientation"
        />
      ) : null}
      {permissions.can_run_orientation && project.status !== 'ACTIVE' ? (
        <Text style={styles.hint}>{t('project.orientationNeedsActive')}</Text>
      ) : null}
      {permissions.can_operate_kiosk && project.status === 'ACTIVE' ? (
        <AppButton
          label={t('kiosk.open')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/kiosk', params: { id: project.id } })
          }
          testID="open-kiosk"
        />
      ) : null}
      {permissions.can_run_visitor_desk && project.status === 'ACTIVE' ? (
        <AppButton
          variant="secondary"
          label={t('kiosk.visitors')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/visitors', params: { id: project.id } })
          }
          testID="open-visitors"
        />
      ) : null}
      {permissions.can_view_roster ? (
        <AppButton
          variant="secondary"
          label={t('project.workersAndApprovals')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/workers', params: { id: project.id } })
          }
          testID="open-workers"
        />
      ) : null}
      {permissions.can_view_roster ? (
        <AppButton
          variant="secondary"
          label={t('reports.open')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/reports', params: { id: project.id } })
          }
          testID="open-reports"
        />
      ) : null}
      {permissions.can_correct_attendance ? (
        <AppButton
          variant="secondary"
          label={t('requests.open')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/requests', params: { id: project.id } })
          }
          testID="open-requests-project"
        />
      ) : null}
      {permissions.can_correct_attendance ? (
        <AppButton
          variant="secondary"
          label={t('kioskGrants.open')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/foremen', params: { id: project.id } })
          }
          testID="open-foremen"
        />
      ) : null}
    </Card>
  );
}

function SiteCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const { config, project } = detail;
  const closed = isClosed(project.status);
  return (
    <Card testID="site-card">
      <Heading>{t('project.siteTitle')}</Heading>
      {project.address ? <Text style={styles.value}>{project.address}</Text> : null}
      <SiteMap
        center={{ lat: config.center_lat, lng: config.center_lng }}
        radiusM={config.radius_m}
        hysteresisM={config.exit_hysteresis_m}
        accessibilityLabel={t('site.mapLabel', {
          meters: config.radius_m,
          address: project.address ?? project.name,
        })}
        testID="project-map"
      />
      <Text style={styles.value} testID="project-radius">
        {t('site.radiusValue', { meters: config.radius_m, feet: metersToFeet(config.radius_m) })}
      </Text>
      <Text style={styles.hint}>
        {t('project.exitBoundary', { meters: config.radius_m + config.exit_hysteresis_m })}
      </Text>
      <Text style={styles.hint} testID="project-timezone">
        {t('timezone.now', {
          zone: project.iana_timezone,
          time: formatNowInZone(project.iana_timezone, activeLocale),
        })}
      </Text>
      <Text style={styles.hint}>
        {t('project.arrivalRules', {
          minutes: Math.round(config.settings.entry_dwell_seconds / 60),
          accuracy: config.settings.max_horizontal_accuracy_m,
        })}
      </Text>
      <Text style={styles.hint} testID="project-version">
        {t('project.versionLine', {
          number: config.version_number,
          date: formatInstant(config.effective_at, project.iana_timezone, activeLocale),
        })}
      </Text>
      {detail.permissions.can_configure && !closed ? (
        <AppButton
          variant="secondary"
          label={t('project.editSettings')}
          onPress={() =>
            router.push({ pathname: '/project/[id]/edit', params: { id: project.id } })
          }
          testID="edit-settings"
        />
      ) : null}
    </Card>
  );
}

function ScheduleCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const settings = detail.config.settings;
  const lines = settings.operates_24_7
    ? [t('projects.open24x7')]
    : describeBlocks(blocksFromWindows(settings.work_windows), t, activeLocale);
  return (
    <Card testID="schedule-card">
      <Heading>{t('project.scheduleTitle')}</Heading>
      {lines.map((line) => (
        <Text key={line} style={styles.value}>
          {line}
        </Text>
      ))}
      <Text style={styles.hint}>{t('project.scheduleNote')}</Text>
    </Card>
  );
}

function HistoryCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  return (
    <Card testID="history-card">
      <Heading>{t('project.historyTitle')}</Heading>
      <Text style={styles.hint}>{t('project.historyNote')}</Text>
      {detail.versions.map((version) => (
        <Text
          key={version.version_number}
          style={styles.value}
          testID={`version-${version.version_number}`}
        >
          {t('project.historyLine', {
            number: version.version_number,
            date: formatInstant(version.effective_at, detail.project.iana_timezone, activeLocale),
            reason: version.reason ?? '',
          })}
        </Text>
      ))}
    </Card>
  );
}

function LifecycleCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ProjectStatus | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = NEXT_STATUSES[detail.project.status];
  if (!detail.permissions.can_configure || options.length === 0) return null;

  const confirm = async () => {
    if (!pending) return;
    if (STATUSES_NEEDING_REASON.includes(pending) && reason.trim().length < 3) {
      setError(t('apiErrors.REASON_REQUIRED'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setStatus(detail.project.id, pending, reason.trim() || null);
      setPending(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(detail.project.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="lifecycle-card">
      <Heading>{t('project.lifecycleTitle')}</Heading>
      {pending ? (
        <>
          <Text style={styles.value}>
            {t('project.confirmStatus', { status: t(`projectStatus.${pending}`) })}
          </Text>
          <Text style={styles.hint}>{t(`projectStatusHelp.${pending}`)}</Text>
          <TextField
            label={
              STATUSES_NEEDING_REASON.includes(pending)
                ? t('project.reasonRequired')
                : t('project.reasonOptional')
            }
            value={reason}
            onChangeText={setReason}
            maxLength={500}
            testID="status-reason"
          />
          <AppButton
            label={busy ? t('common.saving') : t('common.confirm')}
            onPress={() => void confirm()}
            disabled={busy}
            testID="confirm-status"
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => {
              setPending(null);
              setError(null);
            }}
            disabled={busy}
            testID="cancel-status"
          />
        </>
      ) : (
        <View style={styles.actions}>
          {options.map((status) => (
            <AppButton
              key={status}
              variant={status === 'ACTIVE' ? 'primary' : 'secondary'}
              label={t(`project.statusAction.${status}`)}
              onPress={() => setPending(status)}
              testID={`status-${status}`}
            />
          ))}
        </View>
      )}
      {error ? <Banner tone="danger" text={error} testID="status-error" /> : null}
    </Card>
  );
}

function StaffCard({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { activeLocale } = useLanguage();
  const api = useApi();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canManage = detail.permissions.can_assign_staff;
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.project(detail.project.id) });

  const remove = async (staffId: string) => {
    if (reason.trim().length < 3) {
      setError(t('apiErrors.REASON_REQUIRED'));
      return;
    }
    setError(null);
    try {
      await api.removeStaff(staffId, reason.trim());
      setRemoving(null);
      setReason('');
      await refresh();
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  const revoke = async (invitationId: string) => {
    setError(null);
    try {
      await api.revokeInvitation(invitationId);
      await refresh();
    } catch (caught) {
      setError(t(errorMessageKey(caught)));
    }
  };

  return (
    <Card testID="staff-card">
      <Heading>{t('project.staffTitle')}</Heading>
      {detail.staff.map((member) => (
        <View key={member.id} style={styles.staffRow} testID={`staff-${member.id}`}>
          <Text style={styles.value}>{member.email ?? t('project.unknownEmail')}</Text>
          <Text style={styles.hint}>
            {member.emergency_designated
              ? t('project.roleWithEmergency', { role: t(`roles.${member.role}`) })
              : t(`roles.${member.role}`)}
          </Text>
          {canManage && removing === member.id ? (
            <>
              <TextField
                label={t('project.removeReason')}
                value={reason}
                onChangeText={setReason}
                maxLength={500}
                testID="remove-reason"
              />
              <AppButton
                label={t('project.confirmRemove')}
                onPress={() => void remove(member.id)}
                testID="confirm-remove"
              />
              <AppButton
                variant="secondary"
                label={t('common.cancel')}
                onPress={() => setRemoving(null)}
              />
            </>
          ) : canManage ? (
            <AppButton
              variant="secondary"
              label={t('project.removeStaff')}
              onPress={() => {
                setRemoving(member.id);
                setReason('');
              }}
              testID={`remove-${member.id}`}
            />
          ) : null}
        </View>
      ))}
      {canManage ? (
        <>
          <Heading>{t('project.pendingTitle')}</Heading>
          {detail.invitations.length === 0 ? (
            <Text style={styles.hint}>{t('project.noPending')}</Text>
          ) : null}
          {detail.invitations.map((invitation) => (
            <View key={invitation.id} style={styles.staffRow} testID={`pending-${invitation.id}`}>
              <Text style={styles.value}>{invitation.email}</Text>
              <Text style={styles.hint}>
                {t('project.pendingLine', {
                  role: t(`roles.${invitation.role}`),
                  date: formatInstant(
                    invitation.expires_at,
                    detail.project.iana_timezone,
                    activeLocale,
                  ),
                })}
              </Text>
              <AppButton
                variant="secondary"
                label={t('project.revokeInvitation')}
                onPress={() => void revoke(invitation.id)}
                testID={`revoke-${invitation.id}`}
              />
            </View>
          ))}
          {detail.project.status !== 'ARCHIVED' ? (
            <AppButton
              label={t('project.inviteStaff')}
              onPress={() =>
                router.push({ pathname: '/project/[id]/invite', params: { id: detail.project.id } })
              }
              testID="invite-staff"
            />
          ) : null}
        </>
      ) : null}
      {error ? <Banner tone="danger" text={error} testID="staff-error" /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 17, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  actions: { gap: spacing.sm },
  staffRow: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
