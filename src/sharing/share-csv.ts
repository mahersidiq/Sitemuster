import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Shares the worker's own hours CSV through the phone's share sheet (docs/spec/04 "basic personal
 * CSV through native share"). The file lives in the app cache only for the share and is deleted
 * before the next one; it holds only the worker's own rows.
 */
export async function shareCsv(csv: string, fileName: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  await file.write(csv);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
  });
  return true;
}
