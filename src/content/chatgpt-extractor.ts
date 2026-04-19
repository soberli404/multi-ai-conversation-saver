// ChatGPT conversation extractor content script
// Works on both chatgpt.com/c/* (live chat) and chatgpt.com/share/* (share pages)

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

function extractMessages(): ExtractedMessage[] {
  let userMessages: ExtractedMessage[] = []

  // Strategy 1: data-message-author-role attribute (works on live chat and some share pages)
  const roleMessages: ExtractedMessage[] = []
  const turns = document.querySelectorAll('[data-message-author-role]')
  if (turns.length > 0) {
    turns.forEach((el, i) => {
      const role = el.getAttribute('data-message-author-role')
      if (role !== 'user' && role !== 'assistant') return
      const content = cleanText((el as HTMLElement).innerText || '')
      if (!content) return
      roleMessages.push({
        id: `chatgpt-${i}-${Date.now()}`,
        role: role as 'user' | 'assistant',
        content,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(roleMessages)
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && hasAssistant(orderedMessages)) return orderedMessages
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && !hasAssistant(orderedMessages)) {
      userMessages = orderedMessages
    }
  }

  // Strategy 2: article-based structure (newer ChatGPT UI)
  const articleMessages: ExtractedMessage[] = []
  const articles = document.querySelectorAll('article')
  if (articles.length > 0) {
    articles.forEach((el, i) => {
      const text = cleanText(el.innerText || '')
      if (!text) return
      // In ChatGPT, user messages and assistant messages alternate in articles
      // Check for "ChatGPT" label or user avatar indicators
      const hasAssistantLabel = el.querySelector('[data-message-author-role="assistant"]')
        || el.querySelector('img[alt*="ChatGPT"]')
        || el.querySelector('.agent-turn')
      const role: 'user' | 'assistant' = hasAssistantLabel ? 'assistant' : (i % 2 === 0 ? 'user' : 'assistant')
      articleMessages.push({
        id: `chatgpt-art-${i}-${Date.now()}`,
        role,
        content: text,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(articleMessages)
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && hasAssistant(orderedMessages)) return orderedMessages
    if (userMessages.length > 0 && hasAssistant(orderedMessages)) {
      return uniqueMessages([...userMessages, ...orderedMessages])
    }
  }

  // Strategy 3: share page with .markdown class or prose blocks
  const proseMessages: ExtractedMessage[] = []
  const proseBlocks = document.querySelectorAll('.markdown, .prose, .whitespace-pre-wrap')
  if (proseBlocks.length > 0) {
    proseBlocks.forEach((el, i) => {
      const text = cleanText((el as HTMLElement).innerText || '')
      if (!text || text.length < 2) return
      // Alternate: even = user, odd = assistant (common share page pattern)
      proseMessages.push({
        id: `chatgpt-prose-${i}-${Date.now()}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: text,
        timestamp: new Date().toISOString(),
        selected: true,
      })
    })
    const orderedMessages = uniqueMessages(proseMessages)
    if (orderedMessages.length > 0 && hasUser(orderedMessages) && hasAssistant(orderedMessages)) return orderedMessages
    if (userMessages.length > 0 && hasAssistant(orderedMessages)) {
      return uniqueMessages([...userMessages, ...orderedMessages])
    }
  }

  // Strategy 4: last resort — grab all substantial text blocks from main content
  const main = document.querySelector('main') || document.body
  const blocks: string[] = []
  main.querySelectorAll('div, p, section').forEach((el) => {
    const text = cleanText((el as HTMLElement).innerText || '')
    // Only take leaf-ish blocks with meaningful text, skip very short or script-like content
    if (text.length > 20 && !text.startsWith('(function') && !text.includes('use strict') && el.children.length < 5) {
      // Avoid duplicates from nested elements
      if (!blocks.some((b) => b.includes(text) || text.includes(b))) {
        blocks.push(text)
      }
    }
  })
  const fallbackMessages: ExtractedMessage[] = []
  blocks.forEach((text, i) => {
    fallbackMessages.push({
      id: `chatgpt-fallback-${i}-${Date.now()}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: text,
      timestamp: new Date().toISOString(),
      selected: true,
    })
  })

  const orderedMessages = uniqueMessages(fallbackMessages)
  if (userMessages.length > 0 && hasAssistant(orderedMessages)) {
    return uniqueMessages([...userMessages, ...orderedMessages])
  }

  return orderedMessages
}

// Status observer
function observeStatus(callback: (thinking: boolean) => void) {
  const observer = new MutationObserver(() => {
    const stopBtn = document.querySelector('button[aria-label="Stop generating"]')
      || document.querySelector('[data-testid="stop-button"]')
    callback(!!stopBtn)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return observer
}

chrome.runtime.onMessage.addListener((msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (msg.type === 'EXTRACT_CONVERSATION') {
    const messages = extractMessages()
    console.log(`[Codex Modified Container] ChatGPT extracted ${messages.length} messages`)
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
      platform: 'chatgpt',
      thinking,
      url: window.location.href,
    })
  }
})

console.log('[Codex Modified Container] ChatGPT extractor loaded on', window.location.href)
