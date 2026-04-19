interface ExtractedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  selected: boolean
}

function getSourceTitle() {
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
  return metaTitle?.trim() || document.title.trim() || undefined
}

function cleanText(value: string) {
  return value.replace(/\n{3,}/g, '\n\n').trim()
}

function hasAssistant(messages: ExtractedMessage[]) {
  return messages.some((message) => message.role === 'assistant')
}

function hasUser(messages: ExtractedMessage[]) {
  return messages.some((message) => message.role === 'user')
}

function uniqueMessages(messages: ExtractedMessage[]) {
  const seen = new Set<string>()
  return messages.filter((message) => {
    const key = `${message.role}:${message.content}`
    if (!message.content || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function inferRoleFromContent(content: string, fallbackIndex: number): 'user' | 'assistant' {
  const normalized = content.trim()
  if (/^(?:human|user|you|我|用户|问题|提问|prompt)[\s:：\n]/i.test(normalized)) return 'user'
  if (
    /^(?:claude|assistant|当然|好的|可以|Sure|Here|Based on|I can|I'll|下面|以下)/i.test(normalized)
    || normalized.length > 280
  ) {
    return 'assistant'
  }
  return fallbackIndex % 2 === 0 ? 'user' : 'assistant'
}

function inferRoleFromElement(htmlEl: HTMLElement, fallbackIndex: number): 'user' | 'assistant' {
  const fingerprint = [
    htmlEl.tagName,
    htmlEl.getAttribute('data-testid'),
    htmlEl.getAttribute('aria-label'),
    htmlEl.className,
    htmlEl.closest('[data-testid], [class], article')?.getAttribute('data-testid'),
    (htmlEl.closest('[class]') as HTMLElement | null)?.className,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (
    /\b(human|user|prompt)\b/.test(fingerprint)
    || fingerprint.includes('user-message')
    || fingerprint.includes('human-message')
  ) {
    return 'user'
  }

  if (
    /\b(assistant|claude|bot|response)\b/.test(fingerprint)
    || fingerprint.includes('assistant-message')
    || fingerprint.includes('model-message')
  ) {
    return 'assistant'
  }

  return inferRoleFromContent(cleanText(htmlEl.innerText || ''), fallbackIndex)
}

function extractMessages(): ExtractedMessage[] {
  let userMessages: ExtractedMessage[] = []
  const roleAwareNodes = Array.from(
    document.querySelectorAll(
      [
        '[data-testid*="message"]',
        '[data-testid*="assistant"]',
        '[data-testid*="human"]',
        '[data-testid*="user"]',
        'main article',
        'main [class*="message"]',
        'main [class*="prose"]',
        'main [class*="font-claude"]',
      ].join(', '),
    ),
  )

  const roleAwareMessages = roleAwareNodes
    .map((node, index) => {
      const htmlEl = node as HTMLElement
      const contentEl = htmlEl.querySelector(
        '.prose, .whitespace-pre-wrap, [class*="markdown"], [class*="content"], [data-testid*="message-content"]',
      ) as HTMLElement | null
      const content = cleanText((contentEl || htmlEl).innerText || '')
      if (!content || content.length < 2) return null

      return {
        id: `claude-${index}-${Date.now()}`,
        role: inferRoleFromElement(htmlEl, index),
        content,
        timestamp: new Date().toISOString(),
        selected: true,
      }
    })
    .filter((message): message is ExtractedMessage => Boolean(message))

  const orderedRoleAwareMessages = uniqueMessages(roleAwareMessages)
  if (orderedRoleAwareMessages.length > 1 && hasUser(orderedRoleAwareMessages) && hasAssistant(orderedRoleAwareMessages)) {
    return orderedRoleAwareMessages
  }

  if (orderedRoleAwareMessages.length > 0 && hasUser(orderedRoleAwareMessages) && !hasAssistant(orderedRoleAwareMessages)) {
    userMessages = orderedRoleAwareMessages
  }

  const main = document.querySelector('main') || document.body
  const blocks: string[] = []
  main.querySelectorAll('article, section, div, p, li').forEach((el) => {
    const htmlEl = el as HTMLElement
    const text = cleanText(htmlEl.innerText || '')
    if (
      text.length > 20
      && !text.startsWith('(function')
      && !text.includes('use strict')
      && htmlEl.children.length < 5
      && !blocks.some((existing) => existing.includes(text) || text.includes(existing))
    ) {
      blocks.push(text)
    }
  })

  const fallbackMessages = uniqueMessages(
    blocks.map((content, index) => ({
      id: `claude-fallback-${index}-${Date.now()}`,
      role: inferRoleFromContent(content, index),
      content,
      timestamp: new Date().toISOString(),
      selected: true,
    })),
  )

  if (userMessages.length > 0 && hasAssistant(fallbackMessages)) {
    return uniqueMessages([...userMessages, ...fallbackMessages])
  }

  return fallbackMessages
}

chrome.runtime.onMessage.addListener((msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (msg.type === 'EXTRACT_CONVERSATION') {
    const messages = extractMessages()
    console.log(`[Codex Modified Container] Claude extracted ${messages.length} messages`)
    sendResponse({ messages, sourceTitle: getSourceTitle() })
  }
  return true
})

console.log('[Codex Modified Container] Claude extractor loaded on', window.location.href)
