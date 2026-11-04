import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../state/auth';
import { AppButton } from './AppButton';
import { Screen } from './Screen';
import { Body, Title } from './Typography';

/** Simple signed-in information screen with a sign-out action. */
export function InfoScreen({
  title,
  body,
  testID,
  children,
}: {
  title: string;
  body: string;
  testID: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  return (
    <Screen testID={testID}>
      <Title>{title}</Title>
      <Body>{body}</Body>
      {children}
      <AppButton
        variant="secondary"
        label={t('access.signOut')}
        onPress={() => void signOut().then(() => router.replace('/'))}
        testID="sign-out"
      />
    </Screen>
  );
}
