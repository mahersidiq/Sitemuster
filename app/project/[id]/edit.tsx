import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey, sensitiveChangesOf, type SensitiveChange } from '../../../src/api/errors';
import { queryKeys, useProject } from '../../../src/api/hooks';
import type { ProjectDetail } from '../../../src/api/types';
import { AppButton } from '../../../src/components/AppButton';
import { Banner } from '../../../src/components/Banner';
import { Card } from '../../../src/components/Card';
import { ChipGroup } from '../../../src/components/ChipGroup';
import { QueryState } from '../../../src/components/QueryState';
import { RadiusStepper } from '../../../src/components/RadiusStepper';
import { ScheduleEditor } from '../../../src/components/ScheduleEditor';
import { Screen } from '../../../src/components/Screen';
import { SiteMap, type LatLng } from '../../../src/components/SiteMap';
import { StaffGate } from '../../../src/components/StaffGate';
import { TextField } from '../../../src/components/TextField';
import { Body, Heading, Title } from '../../../src/components/Typography';
import { blocksFromWindows, validateSchedule, type ShiftBlock } from '../../../src/projects/shifts';
import { useApi } from '../../../src/state/auth';
import { colors } from '../../../src/theme';

/** Server bounds: dwell 300–3,600 s, accuracy 20–100 m (decision #64). */
const DWELL_MINUTES = [5, 10, 15, 20, 30, 60] as const;
const ACCURACY_METERS = [20, 35, 50, 75, 100] as const;

export default function EditProjectConfigScreen() {
  return (
    <StaffGate>
      <EditLoader />
    </StaffGate>
  );
}

function EditLoader() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const project = useProject(id);
  return (
    <Screen testID="project-edit-screen">
      <Title>{t('edit.title')}</Title>
      <QueryState
        isLoading={project.isLoading}
        error={project.error}
        onRetry={() => void project.refetch()}
      />
      {project.data ? <EditForm detail={project.data} /> : null}
    </Screen>
  );
}

/**
 * Saving writes a NEW immutable configuration version; sessions already open keep the version
 * they started with (decision #29). Sensitive changes need explicit confirmation + reason.
 */
function EditForm({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { config, project } = detail;
  const [center, setCenter] = useState<LatLng>({ lat: config.center_lat, lng: config.center_lng });
  const [radius, setRadius] = useState(config.radius_m);
  const [operates24x7, setOperates24x7] = useState(config.settings.operates_24_7);
  const [blocks, setBlocks] = useState<ShiftBlock[]>(() =>
    blocksFromWindows(config.settings.work_windows),
  );
  const [dwellMinutes, setDwellMinutes] = useState(
    Math.round(config.settings.entry_dwell_seconds / 60),
  );
  const [accuracy, setAccuracy] = useState(config.settings.max_horizontal_accuracy_m);
  const [reason, setReason] = useState('');
  const [sensitive, setSensitive] = useState<SensitiveChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => randomUUID());

  const save = async (confirmSensitive: boolean) => {
    const checked = validateSchedule(blocks, operates24x7);
    if (!checked.ok) {
      setError(t(`scheduleErrors.${checked.error}`));
      return;
    }
    if (reason.trim().length < 3) {
      setError(t('apiErrors.REASON_REQUIRED'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateConfig({
        projectId: project.id,
        centerLat: center.lat,
        centerLng: center.lng,
        radiusM: radius,
        operates24x7,
        workWindows: checked.windows,
        entryDwellSeconds: dwellMinutes * 60,
        maxHorizontalAccuracyM: accuracy,
        reason: reason.trim(),
        confirmSensitive,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: '/project/[id]', params: { id: project.id } });
    } catch (caught) {
      const changes = sensitiveChangesOf(caught);
      if (changes) setSensitive(changes);
      else setError(t(errorMessageKey(caught)));
      setBusy(false);
    }
  };

  return (
    <>
      <Body>{t('edit.body', { number: config.version_number })}</Body>
      <SiteMap
        center={center}
        radiusM={radius}
        hysteresisM={config.exit_hysteresis_m}
        onCenterChange={setCenter}
        accessibilityLabel={t('site.mapLabel', {
          meters: radius,
          address: project.address ?? project.name,
        })}
        testID="edit-map"
      />
      <Text style={styles.hint}>{t('site.dragHint')}</Text>
      <RadiusStepper value={radius} onChange={setRadius} />
      <Heading>{t('project.scheduleTitle')}</Heading>
      <ScheduleEditor
        operates24x7={operates24x7}
        onOperates24x7Change={setOperates24x7}
        blocks={blocks}
        onBlocksChange={setBlocks}
        error={null}
      />
      <Heading>{t('edit.arrivalTitle')}</Heading>
      <Text style={styles.hint}>{t('edit.dwellHint')}</Text>
      <ChipGroup
        label={t('edit.dwellLabel')}
        options={DWELL_MINUTES.map((minutes) => ({
          value: minutes,
          label: t('edit.minutes', { minutes }),
        }))}
        selected={[dwellMinutes]}
        onToggle={setDwellMinutes}
        testID="dwell"
      />
      <Text style={styles.hint}>{t('edit.accuracyHint')}</Text>
      <ChipGroup
        label={t('edit.accuracyLabel')}
        options={ACCURACY_METERS.map((meters) => ({
          value: meters,
          label: t('site.meters', { meters }),
        }))}
        selected={[accuracy]}
        onToggle={setAccuracy}
        testID="accuracy"
      />
      <TextField
        label={t('edit.reason')}
        value={reason}
        onChangeText={setReason}
        maxLength={500}
        testID="edit-reason"
      />
      <Banner tone="info" text={t('edit.versionNote')} />
      {sensitive ? (
        <Card testID="sensitive-confirmation">
          <Heading>{t('edit.sensitiveTitle')}</Heading>
          {sensitive.map((change) => (
            <Text key={change} style={styles.value} testID={`sensitive-${change}`}>
              {t(`sensitive.${change}`)}
            </Text>
          ))}
          <Text style={styles.hint}>{t('edit.sensitiveBody')}</Text>
          <AppButton
            label={busy ? t('common.saving') : t('edit.confirmSensitive')}
            onPress={() => void save(true)}
            disabled={busy}
            testID="confirm-sensitive"
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => setSensitive(null)}
            disabled={busy}
          />
        </Card>
      ) : (
        <AppButton
          label={busy ? t('common.saving') : t('edit.save')}
          onPress={() => void save(false)}
          disabled={busy}
          testID="save-config"
        />
      )}
      {error ? <Banner tone="danger" text={error} testID="edit-error" /> : null}
      <AppButton
        variant="secondary"
        label={t('common.cancel')}
        onPress={() => router.back()}
        disabled={busy}
        testID="edit-cancel"
      />
    </>
  );
}

const styles = StyleSheet.create({
  value: { fontSize: 17, color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
});
