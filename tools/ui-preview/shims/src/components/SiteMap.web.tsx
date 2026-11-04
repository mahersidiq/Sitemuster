import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../theme';

/**
 * WEB RENDER ONLY (tools/ui-preview, decision #52): react-native-maps has no web renderer, so the
 * screenshot build draws a labelled schematic with the same proportions as the native framing
 * (solid circle = radius, dashed ring = radius + exit hysteresis). Phones use src/components/SiteMap.
 */
export interface LatLng {
  lat: number;
  lng: number;
}

export function SiteMap({
  radiusM,
  hysteresisM,
  accessibilityLabel,
  testID,
}: {
  center: LatLng;
  radiusM: number;
  hysteresisM: number;
  onCenterChange?: (center: LatLng) => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const { t } = useTranslation();
  const frame = 240;
  const span = (radiusM + hysteresisM) * 2.8;
  const inner = ((2 * radiusM) / span) * frame;
  const outer = ((2 * (radiusM + hysteresisM)) / span) * frame;
  return (
    <View style={styles.frame} accessibilityLabel={accessibilityLabel} testID={testID}>
      <View style={styles.canvas}>
        <View style={[styles.ring, { width: outer, height: outer, borderRadius: outer / 2 }]} />
        <View style={[styles.circle, { width: inner, height: inner, borderRadius: inner / 2 }]} />
        <View style={styles.pin} />
      </View>
      <Text style={styles.label}>{t('site.webPreview')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 260,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#E8EEE4',
    overflow: 'hidden',
  },
  canvas: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.boundaryStroke,
  },
  circle: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: colors.siteStroke,
    backgroundColor: colors.siteFill,
  },
  pin: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.dangerText,
    borderWidth: 2,
    borderColor: colors.background,
  },
  label: {
    fontSize: 13,
    color: colors.mutedText,
    textAlign: 'center',
    paddingVertical: 4,
    backgroundColor: colors.background,
  },
});
