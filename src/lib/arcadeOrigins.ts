// Origins allowed to drive Arcade SSO (the arcade website that embeds the game).
export const ARCADE_ORIGINS = [
  'https://sterlinglong.me',
  'https://www.sterlinglong.me',
  ...(import.meta.env.DEV ? ['http://localhost:5173', 'http://localhost:5170'] : []),
]
