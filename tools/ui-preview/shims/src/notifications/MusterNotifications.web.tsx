/**
 * Web preview only (tools/ui-preview): expo-notifications has no web implementation of the
 * notification response APIs, and muster alerts are native-only. Nothing to bridge on web.
 */
export function MusterNotifications() {
  return null;
}

export function resetHandledMusterResponses(): void {}
