import type { ReactNode } from 'react';

import { Screen } from './Screen';
import { SignOutButton } from './SignOutButton';
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
  return (
    <Screen testID={testID}>
      <Title>{title}</Title>
      <Body>{body}</Body>
      {children}
      <SignOutButton />
    </Screen>
  );
}
