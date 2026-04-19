interface ExtractedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  selected: boolean
}

interface MessageCandidate {
  role: 'user' | 'assistant'
  content: string
  top: number
  bottom: number
  left: number
}

function cleanText(value: string) {
  return value.replace(/\n{3,}/g, '\n\n').trim()
}

function getSourceTitle() {
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
  const headingTitle = cleanText(
    (document.querySelector('main h1, [role="main"] h1, header h1') as HTMLElement | null)?.innerText || '',
  )

  return metaTitle?.trim() || headingTitle || document.title.trim() || undefined
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

function looksLikeNoiseText(content: string) {
  const normalized = content.trim().toLowerCase()
  if (!normalized) return true
  if (normalized === 'pasted') return true
  if (normalized.length < 8) return true

  const menuKeywords = [
    'new chat',
    'customize chats',
    'projects',
    'artifacts',
    'starred',
    'start your own conversation',
    'shared by',
    'report',
    'content may include unverified',
    'this is a copy of a chat between claude',
  ]

  const hits = menuKeywords.filter((keyword) => normalized.includes(keyword)).length
  if (hits >= 2) return true
  if (normalized.includes('this is a copy of a chat between claude')) return true

  return false
}

function isDateDivider(content: string) {
  const normalized = content.trim()
  return /^(?:\d{1,2}月\d{1,2}日|\d{1,2}:\d{2}|today|yesterday)$/i.test(normalized)
}

function isVisibleElement(htmlEl: HTMLElement) {
  const rect = htmlEl.getBoundingClientRect()
  const style = window.getComputedStyle(htmlEl)

  if (style.display === 'none' || style.visibility === 'hidden') return false
  if (rect.width < 40 || rect.height < 20) return false

  return true
}

function inferRoleFromContent(content: string, fallbackIndex: number): 'user' | 'assistant' {
  const normalized = content.trim()

  if (/^(?:human|user|you|我|用户|问题|提问|prompt)[\s:：\n]/i.test(normalized)) {
    return 'user'
  }

  if (
    /^(?:claude|assistant|当然|好的|可以|sure|here|based on|i can|i'll|下面|以下)/i.test(normalized)
    || normalized.length > 220
  ) {
    return 'assistant'
  }

  return fallbackIndex % 2 === 0 ? 'user' : 'assistant'
}

function inferRoleFromLayout(htmlEl: HTMLElement) {
  const rect = htmlEl.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280

  let current: HTMLElement | null = htmlEl
  let depth = 0

  while (current && depth < 4) {
    const fingerprint = [
      current.tagName,
      current.getAttribute('data-testid'),
      current.getAttribute('aria-label'),
      current.className,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    if (
      /\b(human|user|prompt)\b/.test(fingerprint)
      || fingerprint.includes('user-message')
      || fingerprint.includes('human-message')
      || fingerprint.includes('justify-end')
      || fingerprint.includes('items-end')
      || fingerprint.includes('self-end')
      || fingerprint.includes('ml-auto')
      || fingerprint.includes('text-right')
    ) {
      return 'user'
    }

    if (
      /\b(assistant|claude|bot|response)\b/.test(fingerprint)
      || fingerprint.includes('assistant-message')
      || fingerprint.includes('model-message')
      || fingerprint.includes('prose')
      || fingerprint.includes('markdown')
      || fingerprint.includes('font-claude')
    ) {
      return 'assistant'
    }

    current = current.parentElement
    depth += 1
  }

  if (rect.left > viewportWidth * 0.38 && rect.width < viewportWidth * 0.62) {
    return 'user'
  }

  if (rect.left < viewportWidth * 0.26 && rect.width > viewportWidth * 0.34) {
    return 'assistant'
  }

  return null
}

function shouldSkipElement(htmlEl: HTMLElement, content: string) {
  if (!isVisibleElement(htmlEl)) return true
  if (htmlEl.closest('nav, aside, header, footer, [role="navigation"], [role="banner"]')) return true
  if (htmlEl.tagName === 'BUTTON') return true
  if (isDateDivider(content)) return true
  if (looksLikeNoiseText(content)) return true
  return false
}

function dedupeCandidates(candidates: MessageCandidate[]) {
  return candidates.filter((candidate, index, all) => {
    return !all.some((other, otherIndex) => {
      if (otherIndex === index) return false
      if (other.role !== candidate.role) return false
      const nearSamePosition = Math.abs(other.top - candidate.top) < 24
      const containsCandidate = other.content.length > candidate.content.length && other.content.includes(candidate.content)
      return nearSamePosition && containsCandidate
    })
  })
}

function collectAssistantCandidates() {
  const main = document.querySelector('main, [role="main"]') as HTMLElement | null
  if (!main) return [] as MessageCandidate[]

  const selectors = ['.prose', '[class*="prose"]', '[class*="markdown"]']
  const nodes = Array.from(main.querySelectorAll(selectors.join(', ')))
  const candidates: MessageCandidate[] = []

  for (const node of nodes) {
    const htmlEl = node as HTMLElement
    if (htmlEl.closest('nav, aside, header, footer, [role="navigation"], [role="banner"]')) continue
    if (!isVisibleElement(htmlEl)) continue
    if (htmlEl.parentElement?.closest(selectors.join(', '))) continue

    const content = cleanText(htmlEl.innerText || '')
    if (shouldSkipElement(htmlEl, content)) continue

    const rect = htmlEl.getBoundingClientRect()
    if (rect.left > (window.innerWidth || 1280) * 0.35) continue

    candidates.push({
      role: 'assistant',
      content,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
    })
  }

  return dedupeCandidates(candidates).sort((a, b) => a.top - b.top)
}

function collectUserCandidates() {
  const main = document.querySelector('main, [role="main"]') as HTMLElement | null
  if (!main) return [] as MessageCandidate[]

  const nodes = Array.from(main.querySelectorAll('div, p, span'))
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1280
  const candidates: MessageCandidate[] = []

  for (const node of nodes) {
    const htmlEl = node as HTMLElement
    const content = cleanText(htmlEl.innerText || '')
    if (!content) continue
    if (htmlEl.closest('nav, aside, header, footer, [role="navigation"], [role="banner"]')) continue
    if (htmlEl.closest('.prose, [class*="prose"], [class*="markdown"]')) continue
    if (shouldSkipElement(htmlEl, content)) continue
    if (htmlEl.children.length > 4) continue

    const rect = htmlEl.getBoundingClientRect()
    const layoutRole = inferRoleFromLayout(htmlEl)
    if (layoutRole !== 'user') continue
    if (rect.left < viewportWidth * 0.38) continue
    if (rect.width > viewportWidth * 0.62) continue

    candidates.push({
      role: 'user',
      content,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
    })
  }

  return dedupeCandidates(candidates).sort((a, b) => a.top - b.top)
}

function collectCandidateBlocks() {
  const main = document.querySelector('main, [role="main"]') as HTMLElement | null
  if (!main) return [] as MessageCandidate[]

  const candidates: MessageCandidate[] = []
  const nodes = Array.from(
    main.querySelectorAll(
      [
        'article',
        'div',
        'p',
        'li',
        'pre',
        'blockquote',
        'h2',
        'h3',
      ].join(', '),
    ),
  )

  for (const node of nodes) {
    const htmlEl = node as HTMLElement
    const content = cleanText(htmlEl.innerText || '')
    if (!content) continue
    if (content === cleanText(main.innerText || '')) continue
    if (shouldSkipElement(htmlEl, content)) continue

    const rect = htmlEl.getBoundingClientRect()
    const role = inferRoleFromLayout(htmlEl) ?? inferRoleFromContent(content, candidates.length)

    candidates.push({
      role,
      content,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
    })
  }

  candidates.sort((a, b) => a.top - b.top || a.left - b.left)

  return dedupeCandidates(candidates)
}

function mergeCandidateBlocks(blocks: MessageCandidate[]) {
  if (blocks.length === 0) return []

  const merged: MessageCandidate[] = []

  for (const block of blocks) {
    const previous = merged.at(-1)
    if (
      previous
      && previous.role === block.role
      && block.top - previous.bottom < 140
    ) {
      previous.content = `${previous.content}\n\n${block.content}`.trim()
      previous.bottom = Math.max(previous.bottom, block.bottom)
      continue
    }

    merged.push({ ...block })
  }

  return merged
}

function extractMessages(): ExtractedMessage[] {
  const assistantCandidates = collectAssistantCandidates()
  const userCandidates = collectUserCandidates()
  const fallbackCandidates = collectCandidateBlocks()
  const mergedBlocks = mergeCandidateBlocks(
    assistantCandidates.length > 0 && userCandidates.length > 0
      ? [...assistantCandidates, ...userCandidates].sort((a, b) => a.top - b.top || a.left - b.left)
      : fallbackCandidates,
  )
  const messages = uniqueMessages(
    mergedBlocks.map((block, index) => ({
      id: `claude-${index}-${Date.now()}`,
      role: block.role,
      content: block.content,
      timestamp: new Date().toISOString(),
      selected: true,
    })),
  )

  if (messages.length > 1 && hasUser(messages) && hasAssistant(messages)) {
    return messages
  }

  return messages
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
