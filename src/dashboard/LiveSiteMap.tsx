import { Component, Fragment, useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_DEFAULT, PROVIDER_GOOGLE } from 'react-native-maps';

import type { MapMarker, ProjectMap } from '../api/types';
import { colors } from '../theme';

export interface ShownMarker {
  marker: MapMarker;
  fresh: boolean;
  /** Already localized, e.g. "12 m accuracy · 2 min ago". */
  description: string;
}

/**
 * The site circle and recent qualified positions (Apple Maps on iOS, Google Maps on Android —
 * locked stack). Each position is drawn with its accuracy circle; stale ones are grey. The staff
 * member's own location is never requested or shown.
 */
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
  const region = useMemo(() => {
    const span = ((site.radius_m + site.exit_hysteresis_m) * 2.8) / 111_320;
    const lngScale = Math.max(Math.cos((site.center_lat * Math.PI) / 180), 0.2);
    return {
      latitude: site.center_lat,
      longitude: site.center_lng,
      latitudeDelta: span,
      longitudeDelta: span / lngScale,
    };
  }, [site]);
  const center = { latitude: site.center_lat, longitude: site.center_lng };
  return (
    <View
      style={styles.frame}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <MapView
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={region}
        showsUserLocation={false}
        pitchEnabled={false}
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        <Circle
          center={center}
          radius={site.radius_m}
          strokeColor={colors.siteStroke}
          fillColor={colors.siteFill}
          strokeWidth={2}
        />
        <Circle
          center={center}
          radius={site.radius_m + site.exit_hysteresis_m}
          strokeColor={colors.boundaryStroke}
          lineDashPattern={[8, 6]}
          strokeWidth={1}
        />
        {markers.map(({ marker, fresh, description }) => (
          <Fragment key={marker.worker_id}>
            <Circle
              center={{ latitude: marker.lat, longitude: marker.lng }}
              radius={marker.accuracy_m}
              strokeColor={fresh ? colors.primary : colors.mutedText}
              fillColor={fresh ? 'rgba(11, 95, 165, 0.10)' : 'rgba(74, 85, 96, 0.10)'}
              strokeWidth={1}
            />
            <Marker
              coordinate={{ latitude: marker.lat, longitude: marker.lng }}
              title={marker.legal_name}
              description={description}
              pinColor={fresh ? colors.primary : colors.mutedText}
              opacity={fresh ? 1 : 0.6}
            />
          </Fragment>
        ))}
      </MapView>
    </View>
  );
}

/**
 * A map that cannot render (no map key, a provider error, an old phone) must never take the
 * attendance numbers and lists with it: the fallback replaces only the map.
 */
export class MapErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    // No positions or names in logs: only that the map failed.
    console.warn('map: render failed', error instanceof Error ? error.name : 'unknown');
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  frame: {
    height: 320,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
});
