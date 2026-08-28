export const LIMITS = {
  // Names may wrap on the 80x160 display; choice captions remain deliberately tiny.
  name: 20,
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
