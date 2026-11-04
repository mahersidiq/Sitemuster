import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Banner } from './Banner';
import { Screen } from './Screen';
import { Body, Title } from './Typography';

/** Wireframe shell for a role tab: localized title/description and an explicit preview banner. */
export function ShellScreen({
  title,
  body,
  testID,
  children,
  preview = true,
}: {
  title: string;
  body: string;
  testID?: string;
  children?: ReactNode;
  /** Placeholder tabs keep the preview label; screens with real sections turn it off. */
  preview?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Screen testID={testID}>
      {preview ? <Banner text={t('common.previewBanner')} testID="preview-banner" /> : null}
      <Title>{title}</Title>
      <Body>{body}</Body>
      {children}
    </Screen>
  );
}
