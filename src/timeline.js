export const DURATION = 72;
export const BPM = 120;
export const SECTIONS = [
  { start: 0, end: 6, label: '幕の向こうへ' },
  { start: 6, end: 14, label: 'INTRO / WELCOME' },
  { start: 14, end: 30, label: 'VERSE / NEON DOOR' },
  { start: 30, end: 38, label: 'BUILD / LIGHT UP' },
  { start: 38, end: 54, label: 'CHORUS / TOGETHER' },
  { start: 54, end: 62, label: 'BRIDGE / FLOAT' },
  { start: 62, end: 70, label: 'OUTRO / THANK YOU' },
  { start: 70, end: 72, label: 'SEE YOU AGAIN' },
];
const ease = value => {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
};
export function cue(t) {
  if (t < 0 || !Number.isFinite(t)) return { label: 'STANDBY', curtain: 0 };
  if (t < 2) return { label: 'CURTAIN DROP', curtain: ease(t / 2) };
  if (t < 6) return { label: 'OPENING', curtain: 1 - ease((t - 2) / 4) };
  if (t >= 70) return { label: 'SEE YOU AGAIN', curtain: ease((t - 70) / 2) };
  return { label: SECTIONS.find(section => t < section.end).label, curtain: 0 };
}
