import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, minTouchTarget, spacing } from '../theme';

interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  testID?: string;
  keyboardType?: TextInputProps['keyboardType'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  maxLength?: number;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  large?: boolean;
}

/** Labelled input with an accessible, announced error message. */
export function TextField({ label, error, testID, large = false, ...input }: TextFieldProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...input}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        testID={testID}
        style={[styles.input, large && styles.large, error ? styles.inputError : null]}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          style={styles.error}
          testID={testID ? `${testID}-error` : undefined}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  label: { fontSize: 16, fontWeight: '600', color: colors.text },
  input: {
    minHeight: minTouchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    fontSize: 18,
    color: colors.text,
    backgroundColor: colors.background,
  },
  large: { fontSize: 28, letterSpacing: 6, textAlign: 'center' },
  inputError: { borderColor: colors.dangerText },
  error: { color: colors.dangerText, fontSize: 15 },
});
