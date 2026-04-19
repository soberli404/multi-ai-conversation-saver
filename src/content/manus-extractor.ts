interface ExtractedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

function getSourceTitle() {
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
  return metaTitle?.trim() || document.title.trim() || undefined
}

const MANUS_UI_NOISE = [
  'Watch again',
  'Try it yourself',
  'Skip to results',
  'Sign in',
  'New task',
  'task replay completed',
  'is replaying the task',
  'Manus 1.6',
]

function cleanText(input: string): string {
  return input
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+\n/g, '\n')
    .trim()
}

function isLikelyNoise(text: string): boolean {
  if (!text || text.length < 20) return true
  return MANUS_UI_NOISE.some((phrase) => text.includes(phrase))
}

function uniqueBlocks(blocks: string[]): string[] {
  const result: string[] = []

  for (const block of blocks) {
    if (result.some((existing) => existing.includes(block) || block.includes(existing))) continue
    result.push(block)
  }

  return result
}

function inferRoleFromText(content: string, index: number): 'user' | 'assistant' {
  const fingerprint = content.slice(0, 120).toLowerCase()
  if (/\b(user|question|prompt|ask)\b/.test(fingerprint)) return 'user'
  if (/\b(assistant|answer|response|reply|manus)\b/.test(fingerprint)) return 'assistant'
  return index % 2 === 0 ? 'user' : 'assistant'
}

function blockToMessage(content: string, index: number): ExtractedMessage {
  return {
    id: `manus-${index}-${Date.now()}`,
    role: inferRoleFromText(content, index),
    content,
    timestamp: new Date().toISOString(),
  }
}

function extractMessages(): ExtractedMessage[] {
  const selectors = [
    'main [data-testid*="message"]',
    'main [class*="message"]',
    'main [class*="chat"]',
    'main [class*="markdown"]',
    'main [class*="prose"]',
    'main article',
  ]

  const blocks: string[] = []

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((node) => {
      const text = cleanText((node as HTMLElement).innerText || '')
      if (!isLikelyNoise(text)) blocks.push(text)
    })
    if (blocks.length >= 2) break
  }

  return uniqueBlocks(blocks).map(blockToMessage)
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_CONVERSATION') {
    sendResponse({ messages: extractMessages(), sourceTitle: getSourceTitle() })
  }
  return true
})
