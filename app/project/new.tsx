import { useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { DEFAULT_WORK_WINDOWS, TRACKING_DEFAULTS } from '@sitemuster/shared';

import { errorMessageKey } from '../../src/api/errors';
import { queryKeys, useOrganizations } from '../../src/api/hooks';
import type { ResolvedPlace, SiteCheck } from '../../src/api/types';
import { managedOrganizationIds } from '../../src/auth/routing';
import { AddressSearch } from '../../src/components/AddressSearch';
import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Card } from '../../src/components/Card';
import { ChipGroup } from '../../src/components/ChipGroup';
import { RadiusStepper } from '../../src/components/RadiusStepper';
import { ScheduleEditor } from '../../src/components/ScheduleEditor';
import { Screen } from '../../src/components/Screen';
import { SiteMap, type LatLng } from '../../src/components/SiteMap';
import { StaffGate } from '../../src/components/StaffGate';
import { TextField } from '../../src/components/TextField';
import { TimezonePicker } from '../../src/components/TimezonePicker';
import { Body, Heading, Title } from '../../src/components/Typography';
import { formatNowInZone, metersToFeet } from '../../src/projects/format';
import { describeBlocks } from '../../src/projects/describe';
import { blocksFromWindows, validateSchedule, type ShiftBlock } from '../../src/projects/shifts';
import { useApi, useAuth } from '../../src/state/auth';
import { useLanguage } from '../../src/state/language';
import { colors, spacing } from '../../src/theme';

const STEPS = ['basics', 'site', 'schedule', 'review'] as const;
type Step = (typeof STEPS)[number];
const HYSTERESIS = TRACKING_DEFAULTS.exit_hysteresis_m;

export default function NewProjectScreen() {
  return (
    <StaffGate>
      <NewProjectWizard />
    </StaffGate>
  );
}

/**
 * GC activation: name → address + site circle → time zone + schedule → review. One idempotency
 * key per wizard so a retry after a timeout never creates a second project (spec 01).
 */
function NewProjectWizard() {
  const { t } = useTranslation();
  const api = useApi();
  const { state } = useAuth();
  const { activeLocale } = useLanguage();
  const queryClient = useQueryClient();
  const organizations = useOrganizations();
  const managed = managedOrganizationIds(state);
  const orgOptions = (organizations.data ?? []).filter((org) => managed.includes(org.id));

  const [step, setStep] = useState<Step>('basics');
  const [organizationId, setOrganizationId] = useState<string | null>(managed[0] ?? null);
  const [name, setName] = useState('');
  const [projectNumber, setProjectNumber] = useState('');
  const [place, setPlace] = useState<ResolvedPlace | null>(null);
  const [center, setCenter] = useState<LatLng | null>(null);
  const [radius, setRadius] = useState<number>(TRACKING_DEFAULTS.geofence_radius_m);
  const [timeZone, setTimeZone] = useState('');
  const [operates24x7, setOperates24x7] = useState(false);
  const [blocks, setBlocks] = useState<ShiftBlock[]>(() => blocksFromWindows(DEFAULT_WORK_WINDOWS));
  const [stepError, setStepError] = useState<string | null>(null);
  const [checks, setChecks] = useState<SiteCheck | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [idempotencyKey] = useState(() => randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);

  const stepIndex = STEPS.indexOf(step);
  const go = (next: Step) => {
    setStepError(null);
    setStep(next);
  };

  const runChecks = async () => {
    if (!organizationId || !center) return;
    setChecks(null);
    setCheckFailed(false);
    try {
      setChecks(
        await api.checkSite({
          organizationId,
          name: name.trim(),
          centerLat: center.lat,
          centerLng: center.lng,
          radiusM: radius,
        }),
      );
    } catch {
      // Warnings are advisory; failing to fetch them is shown, never treated as "no overlaps".
      setCheckFailed(true);
    }
  };

  const next = () => {
    if (step === 'basics') {
      if (!organizationId) return setStepError(t('wizard.orgRequired'));
      if (name.trim().length === 0) return setStepError(t('apiErrors.NAME_REQUIRED'));
      if (projectNumber.length > 64) return setStepError(t('apiErrors.PROJECT_NUMBER_TOO_LONG'));
      return go('site');
    }
    if (step === 'site') {
      if (!place || !center) return setStepError(t('wizard.addressRequired'));
      return go('schedule');
    }
    if (step === 'schedule') {
      if (!timeZone) return setStepError(t('wizard.timezoneRequired'));
      const checked = validateSchedule(blocks, operates24x7);
      if (!checked.ok) return setStepError(t(`scheduleErrors.${checked.error}`));
      go('review');
      void runChecks();
    }
    return undefined;
  };

  const create = async () => {
    if (!organizationId || !place || !center) return;
    const checked = validateSchedule(blocks, operates24x7);
    if (!checked.ok) return setStepError(t(`scheduleErrors.${checked.error}`));
    setSubmitting(true);
    setStepError(null);
    try {
      const projectId = await api.createProject({
        organizationId,
        name: name.trim(),
        projectNumber: projectNumber.trim(),
        address: place.formattedAddress,
        centerLat: center.lat,
        centerLng: center.lng,
        ianaTimezone: timeZone,
        radiusM: radius,
        operates24x7,
        workWindows: checked.windows,
        entryDwellSeconds: TRACKING_DEFAULTS.entry_dwell_seconds,
        maxHorizontalAccuracyM: TRACKING_DEFAULTS.max_horizontal_accuracy_m,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      router.replace({ pathname: '/project/[id]', params: { id: projectId, created: '1' } });
    } catch (caught) {
      // A lost response may still have created the project; the same idempotency key makes a
      // retry return that project instead of creating a duplicate.
      setStepError(t(errorMessageKey(caught)));
      setCreateFailed(true);
      setSubmitting(false);
    }
    return undefined;
  };

  return (
    <Screen testID="project-new-screen">
      <Title>{t('wizard.title')}</Title>
      <Text style={styles.progress} testID="wizard-progress">
        {t('wizard.progress', { step: stepIndex + 1, total: STEPS.length })}
      </Text>
      <Heading>{t(`wizard.steps.${step}`)}</Heading>

      {step === 'basics' ? (
        <>
          {orgOptions.length > 1 ? (
            <ChipGroup
              label={t('wizard.organization')}
              options={orgOptions.map((org) => ({ value: org.id, label: org.name }))}
              selected={organizationId ? [organizationId] : []}
              onToggle={setOrganizationId}
              testID="wizard-org"
            />
          ) : null}
          <TextField
            label={t('wizard.name')}
            value={name}
            onChangeText={setName}
            maxLength={200}
            testID="project-name"
          />
          <TextField
            label={t('wizard.number')}
            value={projectNumber}
            onChangeText={setProjectNumber}
            maxLength={64}
            testID="project-number"
          />
        </>
      ) : null}

      {step === 'site' ? (
        <>
          <Body>{t('wizard.siteIntro')}</Body>
          <AddressSearch
            onResolved={(resolved) => {
              setPlace(resolved);
              setCenter({ lat: resolved.lat, lng: resolved.lng });
              setStepError(null);
            }}
          />
          {place && center ? (
            <>
              <Card testID="selected-address">
                <Text style={styles.label}>{t('wizard.selectedAddress')}</Text>
                <Text style={styles.value}>{place.formattedAddress}</Text>
                <Text style={styles.hint}>
                  {t('wizard.attribution', { source: place.attribution })}
                </Text>
              </Card>
              <SiteMap
                center={center}
                radiusM={radius}
                hysteresisM={HYSTERESIS}
                onCenterChange={setCenter}
                accessibilityLabel={t('site.mapLabel', {
                  meters: radius,
                  address: place.formattedAddress,
                })}
                testID="site-map"
              />
              <Text style={styles.hint}>{t('site.dragHint')}</Text>
              <RadiusStepper value={radius} onChange={setRadius} />
              <Banner tone="info" text={t('site.estimateNote', { exit: radius + HYSTERESIS })} />
            </>
          ) : null}
        </>
      ) : null}

      {step === 'schedule' ? (
        <>
          <TimezonePicker value={timeZone} onChange={setTimeZone} />
          <ScheduleEditor
            operates24x7={operates24x7}
            onOperates24x7Change={setOperates24x7}
            blocks={blocks}
            onBlocksChange={setBlocks}
            error={null}
          />
        </>
      ) : null}

      {step === 'review' && place && center ? (
        <>
          <Card testID="review-summary">
            <Text style={styles.value}>{name.trim()}</Text>
            {projectNumber.trim() ? (
              <Text style={styles.hint}>
                {t('projects.number', { number: projectNumber.trim() })}
              </Text>
            ) : null}
            <Text style={styles.hint}>{place.formattedAddress}</Text>
            <Text style={styles.hint}>
              {t('site.radiusValue', { meters: radius, feet: metersToFeet(radius) })}
            </Text>
            <Text style={styles.hint}>
              {t('timezone.now', { zone: timeZone, time: formatNowInZone(timeZone, activeLocale) })}
            </Text>
            {(operates24x7
              ? [t('projects.open24x7')]
              : describeBlocks(blocks, t, activeLocale)
            ).map((line) => (
              <Text key={line} style={styles.hint}>
                {line}
              </Text>
            ))}
            <Text style={styles.hint}>
              {t('wizard.defaultsNote', {
                minutes: TRACKING_DEFAULTS.entry_dwell_seconds / 60,
                accuracy: TRACKING_DEFAULTS.max_horizontal_accuracy_m,
              })}
            </Text>
          </Card>
          {checks?.overlaps.map((overlap) => (
            <Banner
              key={overlap.project_id}
              text={t('wizard.overlapWarning', { name: overlap.name, meters: overlap.distance_m })}
              testID="overlap-warning"
            />
          ))}
          {checks?.similar_names.map((similar) => (
            <Banner
              key={similar.project_id}
              text={t('wizard.similarNameWarning', { name: similar.name })}
              testID="similar-name-warning"
            />
          ))}
          {checks && (checks.overlaps.length > 0 || checks.similar_names.length > 0) ? (
            <Text style={styles.hint}>{t('wizard.warningsAdvisory')}</Text>
          ) : null}
          {checkFailed ? (
            <Banner text={t('wizard.checksUnavailable')} testID="checks-failed" />
          ) : null}
          <Text style={styles.hint}>{t('wizard.draftNote')}</Text>
        </>
      ) : null}

      {stepError ? <Banner tone="danger" text={stepError} testID="wizard-error" /> : null}
      {step === 'review' && createFailed ? (
        <Text style={styles.hint} testID="retry-safe">
          {t('wizard.retrySafe')}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {step === 'review' ? (
          <AppButton
            label={submitting ? t('common.saving') : t('wizard.create')}
            onPress={() => void create()}
            disabled={submitting}
            testID="wizard-create"
          />
        ) : (
          <AppButton label={t('common.next')} onPress={next} testID="wizard-next" />
        )}
        <AppButton
          variant="secondary"
          label={stepIndex === 0 ? t('common.cancel') : t('common.back')}
          onPress={() => {
            const previous = STEPS[stepIndex - 1];
            if (previous) go(previous);
            else router.back();
          }}
          disabled={submitting}
          testID="wizard-back"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  progress: { fontSize: 15, color: colors.mutedText },
  label: { fontSize: 15, fontWeight: '600', color: colors.mutedText },
  value: { fontSize: 17, fontWeight: '600', color: colors.text },
  hint: { fontSize: 15, color: colors.mutedText },
  actions: { gap: spacing.sm },
});
