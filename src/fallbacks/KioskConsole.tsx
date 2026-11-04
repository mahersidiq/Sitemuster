import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorMessageKey } from '../api/errors';
import { AppButton } from '../components/AppButton';
import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { ChipGroup } from '../components/ChipGroup';
import { SyncStatusCard } from '../components/SyncStatusCard';
import { TextField } from '../components/TextField';
import { Body, Heading } from '../components/Typography';
import { installationHash } from '../device/device-store';
import { useApi } from '../state/auth';
import { useOutbox } from '../state/outbox';
import { colors, spacing } from '../theme';
import { classifyBadge, kioskPublicId } from './fallbacks';
import { OutcomeLine } from './OutcomeLine';

const SECURE_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
/** The camera reports the same code many times a second; one scan per code per 5 seconds. */
const REPEAT_WINDOW_MS = 5_000;

type Direction = 'ENTRY' | 'EXIT';

/**
 * Attended kiosk (docs/spec/01 "Kiosk day", docs/spec/04; decision #43): the attendant scans the
 * worker's offline 30-second phone badge or printed card, chooses arriving or leaving, and the
 * record goes into the outbox with this phone's own time. It shows "waiting to sync" until the
 * server answers per person; the kiosk never checks a badge itself (it holds no secrets).
 * A printed badge is weaker evidence: it needs an explicit face-and-name confirmation.
 */
export function KioskConsole({
  projectId,
  nameOf,
  testID = 'kiosk',
}: {
  projectId: string;
  nameOf: (workerId: string) => string | null;
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const outbox = useOutbox();
  const [permission, requestPermission] = useCameraPermissions();
  const [kioskId, setKioskId] = useState<string | null | undefined>(undefined);
  const [direction, setDirection] = useState<Direction>('ENTRY');
  const [typed, setTyped] = useState('');
  const [printed, setPrinted] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const last = useRef<{ code: string; at: number } | null>(null);
  const storageKey = `sitemuster.kiosk.${projectId}.v1`;

  // Register (or take over) this phone as the project's kiosk; offline, reuse the last one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await SecureStore.getItemAsync(storageKey, SECURE_OPTIONS).catch(() => null);
      try {
        const registration = await api.registerKiosk(
          projectId,
          kioskPublicId(await installationHash(), projectId),
        );
        await SecureStore.setItemAsync(storageKey, registration.kiosk_device_id, SECURE_OPTIONS);
        if (!cancelled) setKioskId(registration.kiosk_device_id);
      } catch (error) {
        if (cancelled) return;
        setKioskId(stored ?? null);
        if (!stored) setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, projectId, storageKey, t]);

  const scans = useMemo(
    () =>
      outbox.entries
        .filter(
          (entry) =>
            entry.event.project_id === projectId &&
            (entry.event.operation_type === 'KIOSK_ENTRY' ||
              entry.event.operation_type === 'KIOSK_EXIT'),
        )
        .reverse(),
    [outbox.entries, projectId],
  );

  const record = async (code: string, kind: 'DYNAMIC_APP' | 'PRINTED') => {
    if (!kioskId) return;
    try {
      await outbox.enqueue(
        {
          project_id: projectId,
          operation_type: direction === 'ENTRY' ? 'KIOSK_ENTRY' : 'KIOSK_EXIT',
          observed_at: new Date().toISOString(),
          payload: { badge_payload: code, badge_kind: kind, kiosk_device_id: kioskId, direction },
        },
        { title: kind === 'PRINTED' ? t('kiosk.printedFlag') : t('kiosk.phoneFlag'), badge: kind },
      );
      setMessage({ tone: 'info', text: t('kiosk.recorded') });
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorMessageKey(error)) });
    }
  };

  const scanned = (raw: string) => {
    const badge = classifyBadge(raw);
    if (!badge) {
      setMessage({ tone: 'danger', text: t('kiosk.notBadge') });
      return;
    }
    const now = Date.now();
    if (last.current?.code === badge.code && now - last.current.at < REPEAT_WINDOW_MS) return;
    last.current = { code: badge.code, at: now };
    setTyped('');
    if (badge.kind === 'PRINTED') {
      setPrinted(badge.code); // weaker evidence: the attendant confirms face and name first
      return;
    }
    void record(badge.code, badge.kind);
  };

  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

  if (kioskId === undefined) return <Body>{t('kiosk.settingUp')}</Body>;
  if (kioskId === null) {
    return (
      <>
        <Banner tone="danger" text={t('kiosk.setupNeeded')} testID={`${testID}-setup-needed`} />
        {message ? <Banner tone={message.tone} text={message.text} /> : null}
      </>
    );
  }
  return (
    <View style={styles.stack} testID={testID}>
      <Banner tone="info" text={t('kiosk.attended')} />
      <ChipGroup
        label={t('kiosk.direction')}
        options={[
          { value: 'ENTRY' as const, label: t('kiosk.ENTRY') },
          { value: 'EXIT' as const, label: t('kiosk.EXIT') },
        ]}
        selected={[direction]}
        onToggle={setDirection}
        testID={`${testID}-direction`}
      />
      <Text style={styles.hint}>{t('kiosk.scanHelp')}</Text>
      {permission?.granted ? (
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(result) => scanned(result.data)}
            testID={`${testID}-camera`}
          />
        </View>
      ) : permission ? (
        <>
          <Banner text={t('kiosk.cameraNeeded')} testID={`${testID}-camera-needed`} />
          {permission.canAskAgain ? (
            <AppButton
              label={t('kiosk.allowCamera')}
              onPress={() => void requestPermission()}
              testID={`${testID}-allow-camera`}
            />
          ) : null}
        </>
      ) : null}
      <TextField
        label={t('kiosk.typeLabel')}
        value={typed}
        onChangeText={setTyped}
        maxLength={200}
        testID={`${testID}-code`}
      />
      <AppButton
        variant="secondary"
        label={t('kiosk.record')}
        onPress={() => scanned(typed)}
        testID={`${testID}-record`}
      />
      {printed ? (
        <Card testID={`${testID}-printed`}>
          <Banner tone="warning" text={t('kiosk.printedWarning')} />
          <AppButton
            label={t('kiosk.record')}
            onPress={() => {
              const code = printed;
              setPrinted(null);
              void record(code, 'PRINTED');
            }}
            testID={`${testID}-printed-confirm`}
          />
          <AppButton
            variant="secondary"
            label={t('common.cancel')}
            onPress={() => setPrinted(null)}
            testID={`${testID}-printed-cancel`}
          />
        </Card>
      ) : null}
      {message ? (
        <Banner tone={message.tone} text={message.text} testID={`${testID}-message`} />
      ) : null}
      <SyncStatusCard />
      <Card testID={`${testID}-recent`}>
        <Heading>{t('kiosk.recent')}</Heading>
        {scans.length === 0 ? <Text style={styles.hint}>{t('kiosk.none')}</Text> : null}
        {scans.map((entry) => (
          <View key={entry.event.event_uuid} style={styles.row} testID={`${testID}-scan`}>
            <Text style={styles.line}>
              {`${time(entry.event.observed_at)} · ${t(
                `kiosk.${entry.event.operation_type === 'KIOSK_ENTRY' ? 'ENTRY' : 'EXIT'}`,
              )} · ${entry.label.badge === 'PRINTED' ? t('kiosk.printedFlag') : t('kiosk.phoneFlag')}`}
            </Text>
            <OutcomeLine entry={entry} nameOf={nameOf} />
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  camera: { height: 280, borderRadius: 12, overflow: 'hidden', marginVertical: spacing.sm },
  hint: { fontSize: 15, color: colors.mutedText },
  line: { fontSize: 16, color: colors.text },
  row: { paddingVertical: spacing.xs, gap: 2 },
});
