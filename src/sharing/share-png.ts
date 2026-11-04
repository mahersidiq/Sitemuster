import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Shares a rendered QR (base64 PNG) through the phone's share sheet so it can be printed
 * (AirPrint / Android print services) — expo-print stays V1.1 (locked stack). The file lives in the
 * app cache only for the share; it contains no personal data (orientation/opaque badge codes).
 */
export async function sharePng(base64Png: string, fileName: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  await file.write(base64Png, { encoding: 'base64' });
  await Sharing.shareAsync(file.uri, { mimeType: 'image/png', UTI: 'public.png' });
  return true;
}
