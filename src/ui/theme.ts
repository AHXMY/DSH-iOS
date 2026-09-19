/** 一套 iOS 观感的配色。跟着系统深浅色走，不跟模型走。 */

export type Palette = {
  bg: string
  card: string
  fg: string
  dim: string
  line: string
  accent: string
  userBubble: string
  userText: string
  codeBg: string
  danger: string
}

export const LIGHT: Palette = {
  bg: '#f2f2f7',
  card: '#ffffff',
  fg: '#1c1c1e',
  dim: 'rgba(60,60,67,0.55)',
  line: 'rgba(60,60,67,0.14)',
  accent: '#0a84ff',
  userBubble: '#0a84ff',
  userText: '#ffffff',
  codeBg: 'rgba(120,120,128,0.12)',
  danger: '#c0392b',
}

export const DARK: Palette = {
  bg: '#000000',
  card: '#1c1c1e',
  fg: '#ffffff',
  dim: 'rgba(235,235,245,0.6)',
  line: 'rgba(84,84,88,0.5)',
  accent: '#0a84ff',
  userBubble: '#0a84ff',
  userText: '#ffffff',
  codeBg: 'rgba(120,120,128,0.24)',
  danger: '#ff6b5e',
}

export function paletteFor(scheme: 'light' | 'dark' | null | undefined): Palette {
  return scheme === 'dark' ? DARK : LIGHT
}
