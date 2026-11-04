import { readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';

import { checkCapture, formatReport, parseSite } from './capture-check.mts';

// npm run privacy:capture-check -- <capture.har> --site <lat>,<lng>,<radius_m> [--margin 50]
// Exit code: 0 = PASS, 1 = FAIL, 2 = wrong usage. Prints no coordinate, token or header.
const USAGE =
  'Usage: npm run privacy:capture-check -- <capture.har> --site <latitude>,<longitude>,<radius metres> [--margin 50]';

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const file = argv
  .slice(2)
  .find((arg, index, all) => !arg.startsWith('--') && !all[index - 1]?.startsWith('--'));
const siteText = option('--site');
if (!file || !siteText) {
  stdout.write(`${USAGE}\n`);
  exit(2);
}
try {
  const site = parseSite(
    siteText,
    option('--margin') === undefined ? 50 : Number(option('--margin')),
  );
  const report = checkCapture(JSON.parse(readFileSync(file, 'utf8')) as unknown, site);
  stdout.write(`${formatReport(report, site)}\n`);
  exit(report.verdict === 'PASS' ? 0 : 1);
} catch (error) {
  stdout.write(`${error instanceof Error ? error.message : 'Unreadable input.'}\n${USAGE}\n`);
  exit(2);
}
