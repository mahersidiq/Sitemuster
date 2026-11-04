/**
 * The worker's personal hours CSV (docs/spec/04 "basic personal CSV through native share";
 * CLAUDE.md locked stack: standards-compliant CSV from approved worker-scoped rows). RFC 4180:
 * CRLF line ends, every field quoted when needed, quotes doubled. A cell that a spreadsheet would
 * run as a formula (=, +, -, @, tab, carriage return) is prefixed with an apostrophe. A UTF-8
 * byte-order mark lets spreadsheet apps read Spanish accents correctly.
 */
export interface HoursCsvLabels {
  date: string;
  project: string;
  arrival: string;
  departure: string;
  /** Must say these are estimated onsite hours, not payroll. */
  estimatedHours: string;
  status: string;
}

export interface HoursCsvRow {
  date: string;
  project: string;
  arrival: string;
  departure: string;
  /** Decimal hours as text, e.g. "8.50" (already formatted for the reader's language). */
  estimatedHours: string;
  status: string;
}

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildHoursCsv(labels: HoursCsvLabels, rows: readonly HoursCsvRow[]): string {
  const header = [
    labels.date,
    labels.project,
    labels.arrival,
    labels.departure,
    labels.estimatedHours,
    labels.status,
  ];
  const lines = [
    header,
    ...rows.map((row) => [
      row.date,
      row.project,
      row.arrival,
      row.departure,
      row.estimatedHours,
      row.status,
    ]),
  ].map((cells) => cells.map(csvField).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
