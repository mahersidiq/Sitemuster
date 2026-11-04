import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { orientationCodeKind } from '@sitemuster/shared';

import { AppButton } from '../../src/components/AppButton';
import { Banner } from '../../src/components/Banner';
import { Screen } from '../../src/components/Screen';
import { TextField } from '../../src/components/TextField';
import { Body, Title } from '../../src/components/Typography';
import { useAuth } from '../../src/state/auth';
import { spacing } from '../../src/theme';

/**
 * Scans the supervisor's orientation QR (camera used for QR codes only). Typing/pasting the code
 * is the fallback when the camera is denied or unavailable; either way the server decides.
 */
export default function ScanOrientationScreen() {
  const { t } = useTranslation();
  const { api } = useAuth();
  const { manual } = useLocalSearchParams<{ manual?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const accept = (raw: string) => {
    const code = raw.trim();
    if (!orientationCodeKind(code)) {
      setError(t('join.notOrientationCode'));
      return;
    }
    handled.current = true;
    router.replace({ pathname: '/join/form', params: { code } });
  };

  const showCamera = manual !== '1' && api !== null && permission?.granted === true;
  return (
    <Screen testID="join-scan-screen">
      <Title>{t('join.scanTitle')}</Title>
      <Body>{t('join.scanBody')}</Body>
      {showCamera ? (
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(result) => {
              if (!handled.current) accept(result.data);
            }}
            testID="join-camera"
          />
        </View>
      ) : null}
      {manual !== '1' && permission && !permission.granted ? (
        <>
          <Banner text={t('join.cameraNeeded')} testID="camera-needed" />
          {permission.canAskAgain ? (
            <AppButton
              label={t('join.allowCamera')}
              onPress={() => void requestPermission()}
              testID="allow-camera"
            />
          ) : null}
        </>
      ) : null}
      <TextField
        label={t('join.typeLabel')}
        value={typed}
        onChangeText={setTyped}
        maxLength={120}
        testID="join-code-input"
      />
      <AppButton
        variant="secondary"
        label={t('join.useCode')}
        onPress={() => accept(typed)}
        testID="join-code-submit"
      />
      {error ? <Banner tone="danger" text={error} testID="join-scan-error" /> : null}
      <AppButton
        variant="secondary"
        label={t('common.back')}
        onPress={() => router.back()}
        testID="join-scan-back"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { height: 300, borderRadius: 12, overflow: 'hidden', marginVertical: spacing.sm },
});
