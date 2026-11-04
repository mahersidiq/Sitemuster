import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MapMarker, ProjectMap } from '../api/types';
import { colors } from '../theme';

/**
 * WEB RENDER ONLY (tools/ui-preview, decision #52): react-native-maps has no web renderer, so the
 * screenshot build draws a labelled schematic with the native framing (solid circle = site,
 * dashed ring = exit boundary, dots = positions with their accuracy, grey = stale).
 * Phones use src/dashboard/LiveSiteMap.
 */
export interface ShownMarker {
  marker: MapMarker;
  fresh: boolean;
  description: string;
}

export function LiveSiteMap({
  site,
  markers,
  accessibilityLabel,
  testID = 'live-map',
}: {
  site: NonNullable<ProjectMap['site']>;
  markers: readonly ShownMarker[];
  accessibilityLabel: string;
  testID?: string;
}) {
  const { t } = useTranslation();
  const frame = 280;
  const span = (site.radius_m + site.exit_hysteresis_m) * 2.8;
  const px = (meters: number) => (meters / span) * frame;
  const inner = px(2 * site.radius_m);
  const outer = px(2 * (site.radius_m + site.exit_hysteresis_m));
  const lngScale = Math.cos((site.center_lat * Math.PI) / 180);
  return (
    <View style={styles.frame} accessibilityLabel={accessibilityLabel} testID={testID}>
      <View style={styles.canvas}>
        <View style={[styles.ring, { width: outer, height: outer, borderRadius: outer / 2 }]} />
        <View style={[styles.circle, { width: inner, height: inner, borderRadius: inner / 2 }]} />
        {markers.map(({ marker, fresh }) => {
          const dx = px((marker.lng - site.center_lng) * 111_320 * lngScale);
          const dy = -px((marker.lat - site.center_lat) * 111_320);
          const halo = Math.max(px(2 * marker.accuracy_m), 10);
          return (
            <View
              key={marker.worker_id}
              style={[styles.markerBox, { transform: [{ translateX: dx }, { translateY: dy }] }]}
            >
              <View
                style={[
                  styles.halo,
                  { width: halo, height: halo, borderRadius: halo / 2 },
                  fresh ? styles.haloFresh : styles.haloStale,
                ]}
              />
              <View style={[styles.dot, fresh ? styles.dotFresh : styles.dotStale]} />
            </View>
          );
        })}
      </View>
      <Text style={styles.label}>{t('site.webPreview')}</Text>
    </View>
  );
}

export class MapErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  frame: {
    height: 320,
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
  markerBox: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', borderWidth: 1 },
  haloFresh: { borderColor: colors.primary, backgroundColor: 'rgba(11, 95, 165, 0.12)' },
  haloStale: { borderColor: colors.mutedText, backgroundColor: 'rgba(74, 85, 96, 0.12)' },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.background },
  dotFresh: { backgroundColor: colors.primary },
  dotStale: { backgroundColor: colors.mutedText, opacity: 0.7 },
  label: {
    fontSize: 13,
    color: colors.mutedText,
    textAlign: 'center',
    paddingVertical: 4,
    backgroundColor: colors.background,
  },
});
