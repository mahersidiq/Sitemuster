import { useRef, type RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { colors, spacing } from '../theme';

interface QrRef {
  toDataURL(callback: (base64: string) => void): void;
}

/** Large, high-contrast QR for scanning at arm's length; `onReady` exposes PNG export. */
export function QrBlock({
  value,
  caption,
  size = 260,
  testID,
  pngRef,
}: {
  value: string;
  caption?: string;
  size?: number;
  testID?: string;
  /** Receives a PNG exporter (a ref, not state: updating state here would re-render forever). */
  pngRef?: RefObject<(() => Promise<string>) | null>;
}) {
  const ref = useRef<QrRef | null>(null);
  return (
    <View
      style={styles.frame}
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={caption}
    >
      <QRCode
        value={value}
        size={size}
        ecl="M"
        quietZone={12}
        getRef={(c: QrRef | null) => {
          ref.current = c;
          if (pngRef) {
            pngRef.current = () =>
              new Promise<string>((resolve, reject) => {
                if (!ref.current) reject(new Error('QR not ready'));
                else ref.current.toDataURL(resolve);
              });
          }
        }}
      />
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignSelf: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  caption: { fontSize: 16, color: colors.text, textAlign: 'center', fontWeight: '600' },
});
