/** Minimal design tokens. High contrast and large touch targets for outdoor/jobsite use. */
export const colors = {
  background: '#FFFFFF',
  surface: '#F3F5F7',
  text: '#11181C',
  mutedText: '#4A5560',
  primary: '#0B5FA5',
  onPrimary: '#FFFFFF',
  warningBackground: '#FFF4D6',
  warningText: '#6B4E00',
  dangerBackground: '#FDE7E9',
  dangerText: '#8A1C24',
  border: '#D5DBE1',
  infoBackground: '#E6F0FA',
  infoText: '#0B3D66',
  successBackground: '#E3F4E8',
  successText: '#185C2E',
  siteFill: 'rgba(11, 95, 165, 0.18)',
  siteStroke: '#0B5FA5',
  boundaryStroke: '#6B4E00',
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;

export const minTouchTarget = 48;
