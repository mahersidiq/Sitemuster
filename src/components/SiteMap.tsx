import { useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker, PROVIDER_DEFAULT, PROVIDER_GOOGLE } from 'react-native-maps';

import { colors } from '../theme';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Native map with the site circle (Apple Maps on iOS, Google Maps on Android — locked stack).
 * The solid circle is the configured radius; the dashed ring is the native exit boundary
 * (radius + exit hysteresis). The staff member's own location is never requested or shown.
 * When `onCenterChange` is given the pin can be dragged to fine-tune the site centre.
 */
export function SiteMap({
  center,
  radiusM,
  hysteresisM,
  onCenterChange,
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
  const mapRef = useRef<MapView>(null);
  const region = useMemo(() => {
    const span = ((radiusM + hysteresisM) * 2.8) / 111_320;
    const lngScale = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.2);
    return {
      latitude: center.lat,
      longitude: center.lng,
      latitudeDelta: span,
      longitudeDelta: span / lngScale,
    };
  }, [center.lat, center.lng, radiusM, hysteresisM]);

  useEffect(() => {
    mapRef.current?.animateToRegion(region, 250);
  }, [region]);

  const coordinate = { latitude: center.lat, longitude: center.lng };
  return (
    <View
      style={styles.frame}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : PROVIDER_DEFAULT}
        initialRegion={region}
        showsUserLocation={false}
        pitchEnabled={false}
        rotateEnabled={false}
        toolbarEnabled={false}
      >
        <Circle
          center={coordinate}
          radius={radiusM}
          strokeColor={colors.siteStroke}
          fillColor={colors.siteFill}
          strokeWidth={2}
        />
        <Circle
          center={coordinate}
          radius={radiusM + hysteresisM}
          strokeColor={colors.boundaryStroke}
          lineDashPattern={[8, 6]}
          strokeWidth={1}
        />
        <Marker
          coordinate={coordinate}
          draggable={Boolean(onCenterChange)}
          onDragEnd={(event) =>
            onCenterChange?.({
              lat: event.nativeEvent.coordinate.latitude,
              lng: event.nativeEvent.coordinate.longitude,
            })
          }
        />
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: 260,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
});
