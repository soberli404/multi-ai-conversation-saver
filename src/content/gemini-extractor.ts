// Gemini conversation extractor content script
// Works on gemini.google.com/app/* (live chat) and gemini.google.com/share/* (share pages)

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
  if (/^(?:你说|我说|用户|user|human|question|prompt)[\s:：\n]/i.test(normalized)) return 'user'
  if (
    /^(?:经过联网检索|关于|以下是|当然|可以|好的|Sure|Here is|Here are|根据|结论|明确判定)/i.test(normalized)
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
    htmlEl.closest('[data-testid], [class], user-query, model-response')?.getAttribute('data-testid'),
    (htmlEl.closest('[class]') as HTMLElement | null)?.className,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (
    fingerprint.includes('user-query')
    || fingerprint.includes('query-container')
    || /\b(user|human|question|prompt)\b/.test(fingerprint)
  ) {
    return 'user'
  }

  if (
    fingerprint.includes('model-response')
    || fingerprint.includes('response-container')
    || /\b(assistant|model|response|reply|gemini)\b/.test(fingerprint)
  ) {
    return 'assistant'
  }

  return inferRoleFromContent(cleanText(htmlEl.innerText || ''), fallbackIndex)
}

function extractMessages(): ExtractedMessage[] {
  let queryMessages: ExtractedMessage[] = []

  // Strategy 1: Gemini custom elements (model-response / user-query)
  const userQueries = document.querySelectorAll('user-query')
  const modelResponses = document.querySelectorAll('model-response')

  if (userQueries.length > 0 || modelResponses.length > 0) {
    // Collect all turns with their DOM order
    const allTurns: { el: HTMLElement; role: 'user' | 'assistant' }[] = []
    const domMessages: ExtractedMessage[] = []
    userQueries.forEach((el) => allTurns.push({ el: el as HTMLElement, role: 'user' }))
    modelResponses.forEach((el) => allTurns.push({ el: el as HTMLElement, role: 'assistant' }))

    // Sort by DOM position
    allTurns.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })

    allTurns.forEach((turn, i) => {
      // Get the text content, prefer .query-text or .model-response-text
      const textEl = turn.el.querySelector('.query-text, .model-response-text, .markdown') as HTMLElement | null
      const content = cleanText((textEl || turn.el).innerText || '')
      if (!content) return
      domMessages.push({
        id: `gemini-${i}-${Date.now()}`,
        role: turn.role,
        content,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(domMessages)
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && hasAssistant(orderedMessages)) return orderedMessages
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && !hasAssistant(orderedMessages)) {
      queryMessages = orderedMessages
    }
  }

  // Strategy 2: message-content elements
  const msgContents = document.querySelectorAll('message-content')
  if (msgContents.length > 0) {
    const contentMessages: ExtractedMessage[] = []
    msgContents.forEach((el, i) => {
      const htmlEl = el as HTMLElement
      const role = inferRoleFromElement(htmlEl, i)
      const content = cleanText(htmlEl.innerText || '')
      if (!content) return
      contentMessages.push({
        id: `gemini-mc-${i}-${Date.now()}`,
        role,
        content,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(contentMessages)
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && hasAssistant(orderedMessages)) return orderedMessages
    if (queryMessages.length > 0 && orderedMessages.length > 0 && hasAssistant(orderedMessages)) {
      return uniqueMessages([...queryMessages, ...orderedMessages])
    }
  }

  // Strategy 3: share page — broaden role detection for rendered turn containers
  const richTurnCandidates = Array.from(
    document.querySelectorAll(
      [
        'user-query',
        'model-response',
        '[data-testid*="user-query"]',
        '[data-testid*="model-response"]',
        '[class*="user-query"]',
        '[class*="model-response"]',
        '[class*="query-container"]',
        '[class*="response-container"]',
        '[class*="conversation-turn"]',
        '[class*="message-row"]',
      ].join(', '),
    ),
  )

  if (richTurnCandidates.length > 0) {
    const richMessages = richTurnCandidates
      .map((el, i) => {
        const htmlEl = el as HTMLElement
        const role = inferRoleFromElement(htmlEl, i)

        const contentEl = htmlEl.querySelector(
          'message-content, .query-text, .model-response-text, .markdown, .prose, [class*="content"]',
        ) as HTMLElement | null
        const content = cleanText((contentEl || htmlEl).innerText || '')
        if (!content || content.length < 2) return null

        return {
          id: `gemini-rich-${i}-${Date.now()}`,
          role,
          content,
          timestamp: new Date().toISOString(),
          selected: true,
        }
      })
      .filter((message): message is ExtractedMessage => Boolean(message))

    if (richMessages.length > 1 && hasUser(richMessages) && hasAssistant(richMessages)) {
      return uniqueMessages(richMessages)
    }
  }

  // Strategy 4: share page — look for conversation-turn or similar containers
  const turnContainers = document.querySelectorAll(
    '.conversation-turn, [class*="turn"], [class*="message-row"], [class*="chat-turn"]'
  )
  if (turnContainers.length > 0) {
    const turnMessages: ExtractedMessage[] = []
    turnContainers.forEach((el, i) => {
      const htmlEl = el as HTMLElement
      const content = cleanText(htmlEl.innerText || '')
      if (!content || content.length < 3) return
      turnMessages.push({
        id: `gemini-turn-${i}-${Date.now()}`,
        role: inferRoleFromElement(htmlEl, i),
        content,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(turnMessages)
    if (orderedMessages.length > 0) return orderedMessages
  }

  // Strategy 5: fallback — grab substantial text blocks, filter out JS code
  const main = document.querySelector('main, [role="main"], .conversation-container') || document.body
  const blocks: string[] = []
  main.querySelectorAll('div, p, section').forEach((el) => {
    const text = cleanText((el as HTMLElement).innerText || '')
    if (
      text.length > 20
      && !text.startsWith('(function')
      && !text.includes('use strict')
      && !text.includes('gbar_')
      && !text.includes('_DumpException')
      && !text.includes('createElement')
      && el.children.length < 5
    ) {
      if (!blocks.some((b) => b.includes(text) || text.includes(b))) {
        blocks.push(text)
      }
    }
  })
  const fallbackMessages: ExtractedMessage[] = []
  blocks.forEach((text, i) => {
    fallbackMessages.push({
      id: `gemini-fallback-${i}-${Date.now()}`,
      role: inferRoleFromContent(text, i),
      content: text,
      timestamp: new Date().toISOString(),
      selected: true,
    })
  })

  return uniqueMessages(fallbackMessages)
}

function observeStatus(callback: (thinking: boolean) => void) {
  const observer = new MutationObserver(() => {
    const loading = document.querySelector(
      '.loading-indicator, [data-loading="true"], .generating, mat-progress-bar, .thinking-indicator'
    )
    callback(!!loading)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return observer
}

chrome.runtime.onMessage.addListener((msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (msg.type === 'EXTRACT_CONVERSATION') {
    const messages = extractMessages()
    console.log(`[Codex Modified Container] Gemini extracted ${messages.length} messages`)
    sendResponse({ messages, sourceTitle: getSourceTitle() })
  }
  return true
})

let lastThinking = false
observeStatus((thinking) => {
  if (thinking !== lastThinking) {
    lastThinking = thinking
    chrome.runtime.sendMessage({
      type: 'STATUS_CHANGE',
      platform: 'gemini',
      thinking,
      url: window.location.href,
    })
  }
})

console.log('[Codex Modified Container] Gemini extractor loaded on', window.location.href)
