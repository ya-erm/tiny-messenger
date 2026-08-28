export const LIMITS = {
  // 80x160 display: roughly 12-13 compact glyphs per line. Two choice
  // captions share the 80 px width, so each one deliberately stays tiny.
  name: 14,
  nickname: 32,
  avatarUrl: 500,
  message: 96,
  option: 8,
  optionId: 64,
  choiceOptionsMin: 2,
  choiceOptionsMax: 2,
  tokenMin: 8,
  tokenMax: 64,
  pageSize: 100,
} as const;

export const API_VERSION = 1;
