interface ExtractedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  selected: boolean
}

interface MessageCandidate {
  role: 'user' | 'assistant'
  node: Element
  text: string
  top: number
  rect?: DOMRect | null
}

const SELECTORS = {
  main: 'main, [role="main"], article',
  user: '[data-testid="user-message"], .font-user-message',
  assistant: '.font-claude-message, .font-claude-response',
  turn: '.group\\/conversation-turn, [class*="conversation-turn"]',
  prose: '.font-claude-message .prose, .font-claude-response .prose, .prose',
} as const

const NOISE_ANCESTORS = [
  'nav',
  'aside',
  'header',
  'footer',
  'form',
  'dialog',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[data-radix-popper-content-wrapper]',
].join(', ')

const DROP_INSIDE_MESSAGE = [
  'script',
  'style',
  'noscript',
  'svg',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  '[role="button"]',
  '[role="menu"]',
  '[aria-hidden="true"]',
].join(', ')

const EXACT_UI_LINES = new Set([
  'New chat',
  'Chats',
  'Projects',
  'Artifacts',
  'Customize Claude',
  'Customize Chats',
  'Recents',
  'Settings',
  'Report',
  'Share',
  'Copy',
  'Retry',
  'Start your own conversation',
  'Sign in',
  'Create account',
  'Continue with Google',
  'Claude can make mistakes. Please double-check responses.',
  'Shared by',
])

const DATE_LINE_PATTERNS = [
  /^\d{1,2}月\d{1,2}日(?:\s*(?:周|星期)[一二三四五六日天])?$/i,
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:,\s*\d{4})?$/i,
  /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/i,
  /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/i,
  /^\d{1,2}:\d{2}$/,
  /^(today|yesterday)$/i,
] as const

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanText(raw: string) {
  if (!raw) return ''

  const text = raw
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\r/g, '\n')

  let lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  lines = lines.filter((line) => {
    if (isDateOnlyLine(line)) return false
    if (EXACT_UI_LINES.has(line)) return false
    if (/^Shared by\b/i.test(line)) return false
    return true
  })

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isDateOnlyLine(line: string) {
  const normalized = line.trim()
  return DATE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))
}

function safeRect(node: Element) {
  try {
    return node.getBoundingClientRect()
  } catch {
    return null
  }
}

function isVisible(node: Element) {
  const rect = safeRect(node)
  if (!rect || rect.width <= 0 || rect.height <= 0) return false

  const style = window.getComputedStyle(node as HTMLElement)
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
}

function isInsideNoise(node: Element) {
  if (node.matches(`${SELECTORS.user}, ${SELECTORS.assistant}`)) return false
  return Boolean(node.closest(NOISE_ANCESTORS))
}

function cleanDocumentTitle(value: string) {
  return cleanText(
    String(value || '')
      .replace(/\s*[|-]\s*Claude\s*$/i, '')
      .replace(/^Claude\s*[|-]\s*/i, '')
      .replace(/^Shared Conversation\s*[|-]\s*/i, ''),
  )
}

function getSourceTitle(messages?: ExtractedMessage[]) {
  const metaTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')

  const mainHeading = Array.from(document.querySelectorAll('main h1, [role="main"] h1, article h1'))
    .map((el) => cleanText((el as HTMLElement).innerText || ''))
    .find((value) => isGoodTitle(value))

  const docTitle = cleanDocumentTitle(document.title)

  if (isGoodTitle(metaTitle || '')) return cleanText(metaTitle as string)
  if (mainHeading) return mainHeading
  if (isGoodTitle(docTitle)) return docTitle

  if (messages?.length) {
    return extractTitleFromMessages(messages)
  }

  return undefined
}

function extractShareId() {
  const match = window.location.pathname.match(/\/share\/([^/?#]+)/)
  return match?.[1] ?? `claude-${Date.now()}`
}

function fingerprint(role: 'user' | 'assistant', text: string) {
  return `${role}:${cleanText(text).replace(/\s+/g, ' ').toLowerCase()}`
}

function compareNodeOrder(a: Element, b: Element) {
  if (a === b) return 0
  const pos = a.compareDocumentPosition(b)
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
  return (safeRect(a)?.top ?? 0) - (safeRect(b)?.top ?? 0)
}

function lowestCommonAncestor(nodes: Element[]) {
  if (!nodes.length) return null

  const paths = nodes.map((node) => {
    const path: Element[] = []
    let current: Element | null = node
    while (current) {
      path.unshift(current)
      current = current.parentElement
    }
    return path
  })

  let lca: Element | null = null
  const minLength = Math.min(...paths.map((path) => path.length))

  for (let index = 0; index < minLength; index += 1) {
    const candidate = paths[0][index]
    if (paths.every((path) => path[index] === candidate)) {
      lca = candidate
    } else {
      break
    }
  }

  return lca
}

function readCodeLanguage(node: Element) {
  const className = String((node as HTMLElement).className || '')
  const match = className.match(/language-([a-z0-9_-]+)/i)
  return match?.[1] ?? ''
}

function isBlockTag(tagName: string) {
  return [
    'DIV',
    'P',
    'SECTION',
    'ARTICLE',
    'MAIN',
    'BLOCKQUOTE',
    'UL',
    'OL',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'PRE',
  ].includes(tagName)
}

function cleanInlineText(value: string) {
  return cleanText(value).replace(/\n+/g, ' ')
}

function nodeToMarkdownishText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || ''
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  const element = node as Element
  if (element.matches(DROP_INSIDE_MESSAGE)) {
    return ''
  }

  if ((element as HTMLElement).innerText && isInsideNoise(element)) {
    return ''
  }

  if (element.tagName === 'BR') {
    return '\n'
  }

  if (element.tagName === 'PRE') {
    const codeNode = element.querySelector('code') || element
    const code = (codeNode.textContent || '').trim()
    if (!code) return ''
    const lang = readCodeLanguage(codeNode)
    return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`
  }

  if (element.tagName === 'CODE' && !element.closest('pre')) {
    const text = cleanInlineText(element.textContent || '')
    return text ? `\`${text}\`` : ''
  }

  if (element.tagName === 'LI') {
    const body = Array.from(element.childNodes).map(nodeToMarkdownishText).join('').trim()
    return body ? `\n- ${body}\n` : ''
  }

  if (element.tagName === 'TR') {
    const cells = Array.from(element.children)
      .filter((child) => ['TD', 'TH'].includes(child.tagName))
      .map((child) => cleanInlineText(nodeToMarkdownishText(child)))
      .filter(Boolean)
    return cells.length ? `\n| ${cells.join(' | ')} |\n` : ''
  }

  const childText = Array.from(element.childNodes).map(nodeToMarkdownishText).join('')
  if (isBlockTag(element.tagName)) {
    const trimmed = childText.trim()
    return trimmed ? `\n${trimmed}\n` : ''
  }

  return childText
}

function elementToReadableText(node: Element) {
  return cleanText(nodeToMarkdownishText(node))
}

function looksLikeMessageArray(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 2) return false

  let roleHits = 0
  let contentHits = 0

  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue
    if (readRole(item)) roleHits += 1
    if (readContent(item)) contentHits += 1
  }

  return roleHits >= 2 && contentHits >= 2
}

function readRole(message: Record<string, unknown>) {
  const raw = String(
    message.role
    ?? message.sender
    ?? message.author
    ?? message.type
    ?? message.from
    ?? '',
  ).toLowerCase()

  if (/human|user/.test(raw)) return 'user' as const
  if (/assistant|claude|model|bot/.test(raw)) return 'assistant' as const
  return null
}

function normalizeContentValue(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return cleanText(value)

  if (Array.isArray(value)) {
    return cleanText(value.map((part) => normalizeContentValue(part)).filter(Boolean).join('\n\n'))
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    return normalizeContentValue(
      objectValue.text
      ?? objectValue.value
      ?? objectValue.content
      ?? objectValue.markdown
      ?? objectValue.body,
    )
  }

  return ''
}

function readContent(message: Record<string, unknown>) {
  return normalizeContentValue(
    message.text
    ?? message.markdown
    ?? message.body
    ?? message.message
    ?? message.content
    ?? message.contents,
  )
}

function findNearbyTitle(root: unknown) {
  const titles: string[] = []
  const seen = new WeakSet<object>()

  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return
    if (seen.has(value as object)) return
    seen.add(value as object)

    if (!Array.isArray(value)) {
      for (const key of ['title', 'name', 'summary']) {
        const candidate = (value as Record<string, unknown>)[key]
        if (typeof candidate === 'string' && isGoodTitle(candidate)) {
          titles.push(cleanText(candidate))
        }
      }
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        walk(child)
      }
    }
  }

  walk(root)
  return titles[0] || ''
}

function buildMessagesFromRaw(rawMessages: Array<Record<string, unknown>>) {
  return rawMessages
    .map((message) => ({
      id: `${extractShareId()}-${crypto.randomUUID()}`,
      role: readRole(message),
      content: readContent(message),
      timestamp: new Date().toISOString(),
      selected: true,
    }))
    .filter((message): message is ExtractedMessage => Boolean(message.role && message.content))
}

function extractFromEmbeddedJson() {
  const scripts = Array.from(document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script'))

  for (const script of scripts) {
    const raw = script.textContent?.trim()
    if (!raw || raw.length < 20 || raw.length > 10_000_000) continue
    if (!(raw.startsWith('{') || raw.startsWith('['))) continue
    if (!/(message|conversation|chat|claude)/i.test(raw)) continue

    try {
      const json = JSON.parse(raw) as unknown
      const candidate = findConversationInJson(json)
      if (!candidate?.messages?.length) continue

      const messages = buildMessagesFromRaw(candidate.messages)
      if (!validateMessages(messages).ok) continue

      return {
        messages,
        sourceTitle: candidate.title || getSourceTitle(messages),
      }
    } catch {
      continue
    }
  }

  return null
}

function findConversationInJson(root: unknown): { messages: Array<Record<string, unknown>>; title: string } | null {
  const seen = new WeakSet<object>()
  const candidates: Array<{ messages: Array<Record<string, unknown>>; title: string }> = []

  function walk(value: unknown) {
    if (!value || typeof value !== 'object') return
    if (seen.has(value as object)) return
    seen.add(value as object)

    if (Array.isArray(value)) {
      if (looksLikeMessageArray(value)) {
        candidates.push({
          messages: value,
          title: findNearbyTitle(root),
        })
      }

      value.forEach((item) => walk(item))
      return
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(child) && /messages|chat_messages|turns|conversation/i.test(key) && looksLikeMessageArray(child)) {
        candidates.push({
          messages: child,
          title:
            String((value as Record<string, unknown>).title || (value as Record<string, unknown>).name || (value as Record<string, unknown>).summary || '')
            || findNearbyTitle(root),
        })
      }

      if (child && typeof child === 'object') {
        walk(child)
      }
    }
  }

  walk(root)
  candidates.sort((a, b) => b.messages.length - a.messages.length)
  return candidates[0] || null
}

function findBestMainContainer() {
  const anchors = Array.from(document.querySelectorAll(`${SELECTORS.user}, ${SELECTORS.assistant}`))
  const mains = Array.from(document.querySelectorAll(SELECTORS.main)).filter(isVisible)

  if (mains.length) {
    mains.sort((a, b) => scoreMain(b, anchors) - scoreMain(a, anchors))
    if (scoreMain(mains[0], anchors) > 0) return mains[0]
  }

  if (anchors.length) {
    return lowestCommonAncestor(anchors) || document.body
  }

  return document.body
}

function scoreMain(node: Element, anchors: Element[]) {
  let score = 0
  for (const anchor of anchors) {
    if (node.contains(anchor)) score += 10
  }

  const text = cleanText((node as HTMLElement).innerText || node.textContent || '')
  if (text.length > 100) score += 1
  if (isInsideNoise(node)) score -= 100

  return score
}

function getMessageRoot(node: Element, role: 'user' | 'assistant') {
  if (role === 'user') {
    return node.closest('.font-user-message, [data-testid="user-message"]') || node
  }

  return node.closest('.font-claude-message, .font-claude-response, .group\\/conversation-turn, [class*="conversation-turn"]') || node
}

function collectSelectorMessages(main: Element) {
  const candidates: MessageCandidate[] = []

  for (const node of Array.from(main.querySelectorAll(SELECTORS.user))) {
    if (!isVisible(node) || isInsideNoise(node)) continue
    const root = getMessageRoot(node, 'user')
    const text = elementToReadableText(root)
    if (!text) continue
    candidates.push({
      role: 'user',
      node: root,
      text,
      top: safeRect(root)?.top ?? 0,
    })
  }

  for (const node of Array.from(main.querySelectorAll(SELECTORS.assistant))) {
    if (!isVisible(node) || isInsideNoise(node)) continue
    if (node.closest(SELECTORS.user)) continue
    const root = getMessageRoot(node, 'assistant')
    const text = elementToReadableText(root)
    if (!text) continue
    candidates.push({
      role: 'assistant',
      node: root,
      text,
      top: safeRect(root)?.top ?? 0,
    })
  }

  return dedupeMessages(candidates)
}

function directChildOf(parent: Element, descendant: Element) {
  let current: Element | null = descendant
  while (current && current.parentElement !== parent) {
    current = current.parentElement
  }
  return current
}

function findMessageListContainer(userAnchors: Element[], main: Element) {
  let node: Element | null = userAnchors[0]

  while (node && node !== document.body && node !== main.parentElement) {
    const buckets = new Set<Element>()

    for (const anchor of userAnchors) {
      if (!node.contains(anchor)) continue
      const direct = directChildOf(node, anchor)
      if (direct) buckets.add(direct)
    }

    if (buckets.size >= Math.min(2, userAnchors.length)) {
      return node
    }

    node = node.parentElement
  }

  return main
}

function looksLikeAssistantBlock(node: Element, main: Element) {
  if (!isVisible(node) || isInsideNoise(node)) return false
  if (node.querySelector(SELECTORS.user)) return false

  const text = elementToReadableText(node)
  if (!text || text.length < 12) return false
  if (isMostlyNoiseText(text)) return false

  const rect = safeRect(node)
  const mainRect = safeRect(main)
  if (!rect || !mainRect) return false

  let score = 0

  if (node.matches(SELECTORS.assistant) || node.querySelector(SELECTORS.assistant)) score += 4
  if (node.querySelector(SELECTORS.prose)) score += 3
  if (node.querySelector('p, li, pre, code, blockquote, table, h1, h2, h3')) score += 2
  if (mainRect.width > 0 && rect.left < mainRect.left + mainRect.width * 0.45) score += 1
  if (mainRect.width > 0 && rect.width > mainRect.width * 0.35) score += 1

  const actionCount = node.querySelectorAll('button, a, [role="button"]').length
  const contentCount = node.querySelectorAll('p, li, pre, code, blockquote, table').length
  if (actionCount > contentCount + 3) score -= 3

  return score >= 3
}

function collectLayoutMessages(main: Element) {
  const userAnchors = Array.from(main.querySelectorAll(SELECTORS.user)).filter((node) => isVisible(node) && !isInsideNoise(node))
  if (!userAnchors.length) return [] as MessageCandidate[]

  const list = findMessageListContainer(userAnchors, main)
  const children = Array.from(list.children).filter(isVisible)
  const candidates: MessageCandidate[] = []

  for (const child of children) {
    if (isInsideNoise(child)) continue

    const userNode = child.querySelector(SELECTORS.user)
    if (userNode) {
      const root = getMessageRoot(userNode, 'user')
      const text = elementToReadableText(root)
      if (!text) continue
      candidates.push({
        role: 'user',
        node: root,
        text,
        top: safeRect(root)?.top ?? 0,
      })
      continue
    }

    if (looksLikeAssistantBlock(child, main)) {
      const text = elementToReadableText(child)
      if (!text) continue
      candidates.push({
        role: 'assistant',
        node: child,
        text,
        top: safeRect(child)?.top ?? 0,
      })
    }
  }

  return dedupeMessages(candidates)
}

function dedupeMessages(messages: MessageCandidate[]) {
  const sorted = messages
    .filter((message) => message.text)
    .sort((a, b) => compareNodeOrder(a.node, b.node))

  const out: Array<MessageCandidate & { rect: DOMRect | null }> = []

  for (const message of sorted) {
    const rect = safeRect(message.node)
    const duplicate = out.some((previous) => {
      if (previous.role !== message.role) return false

      const sameText = fingerprint(previous.role, previous.text) === fingerprint(message.role, message.text)
      const contains =
        previous.node !== message.node &&
        (previous.node.contains(message.node) || message.node.contains(previous.node))
      const closeVertically = Math.abs((previous.rect?.top ?? 0) - (rect?.top ?? Number.MAX_SAFE_INTEGER)) < 4

      return sameText || contains || closeVertically
    })

    if (!duplicate) {
      out.push({
        ...message,
        rect,
      })
    }
  }

  return out.map(({ rect, ...message }) => {
    void rect
    return message
  })
}

function collapseAdjacentSameRole(messages: MessageCandidate[]) {
  const out: Array<MessageCandidate & { rect: DOMRect | null }> = []

  for (const message of messages) {
    const rect = safeRect(message.node)
    const previous = out[out.length - 1]

    if (
      previous
      && previous.role === message.role
      && previous.rect
      && rect
      && rect.top - previous.rect.bottom < 80
    ) {
      previous.text = cleanText(`${previous.text}\n\n${message.text}`)
      previous.rect = rect
      continue
    }

    out.push({
      ...message,
      rect,
    })
  }

  return out.map(({ rect, ...message }) => {
    void rect
    return message
  })
}

function isMostlyNoiseText(text: string) {
  const lines = cleanText(text).split('\n').filter(Boolean)
  if (!lines.length) return true

  const noiseCount = lines.filter((line) => {
    return isDateOnlyLine(line) || EXACT_UI_LINES.has(line) || /^Shared by\b/i.test(line)
  }).length

  return noiseCount / lines.length > 0.5
}

function extractTitleFromMessages(messages: ExtractedMessage[]) {
  const firstUser = messages.find((message) => message.role === 'user')?.content || ''
  if (isGoodTitle(firstUser) && firstUser.length >= 8) {
    return truncateTitle(firstUser)
  }

  const firstAssistant = messages.find((message) => message.role === 'assistant')?.content || ''
  const assistantLine = firstAssistant
    .split('\n')
    .map((line) => line.trim())
    .find((line) => isGoodTitle(line))

  if (assistantLine) return truncateTitle(assistantLine)
  if (firstUser) return truncateTitle(firstUser)
  return 'Claude shared conversation'
}

function isGoodTitle(value: string) {
  const text = cleanText(value)
  if (!text || text.length < 4 || text.length > 160) return false
  if (isDateOnlyLine(text)) return false
  if (EXACT_UI_LINES.has(text)) return false
  if (/^Shared by\b/i.test(text)) return false
  if (/^Claude$/i.test(text)) return false
  if (/^Start your own conversation$/i.test(text)) return false
  return true
}

function truncateTitle(value: string, max = 80) {
  const text = cleanText(value).replace(/\n+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function validateMessages(messages: ExtractedMessage[]) {
  const userCount = messages.filter((message) => message.role === 'user').length
  const assistantCount = messages.filter((message) => message.role === 'assistant').length
  const problems: string[] = []

  if (messages.length === 0) problems.push('NO_TURNS')
  if (userCount > 0 && assistantCount === 0) problems.push('NO_ASSISTANT')
  if (assistantCount < Math.max(1, userCount - 1)) problems.push('ASSISTANT_COUNT_LOW')

  const assistantText = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content)
    .join('\n')

  if (/New chat|Customize Chats|Projects|Artifacts|Start your own conversation|Shared by/i.test(assistantText)) {
    problems.push('ASSISTANT_CONTAINS_NAV_NOISE')
  }

  return {
    ok: problems.length === 0,
    problems,
  }
}

function flattenCandidates(messages: MessageCandidate[]) {
  return messages.map((message, index) => ({
    id: `${extractShareId()}-${index}-${Date.now()}`,
    role: message.role,
    content: message.text,
    timestamp: new Date().toISOString(),
    selected: true,
  }))
}

function extractFromDOM() {
  const main = findBestMainContainer()
  const selectorMessages = collectSelectorMessages(main)
  const selectorAssistantCount = selectorMessages.filter((message) => message.role === 'assistant').length
  const selectorUserCount = selectorMessages.filter((message) => message.role === 'user').length

  let messages = selectorMessages

  if (selectorAssistantCount === 0 || selectorAssistantCount < Math.max(1, selectorUserCount - 1)) {
    const layoutMessages = collectLayoutMessages(main)
    messages = dedupeMessages([...selectorMessages, ...layoutMessages])
  }

  messages = collapseAdjacentSameRole(messages)
    .filter((message) => message.text && !isMostlyNoiseText(message.text))
    .sort((a, b) => compareNodeOrder(a.node, b.node))

  const extracted = flattenCandidates(messages)
  return {
    messages: extracted,
    sourceTitle: getSourceTitle(extracted),
  }
}

async function waitForClaudeMessages(timeoutMs = 12000) {
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    if (document.querySelector(`${SELECTORS.user}, ${SELECTORS.assistant}`)) {
      await delay(300)
      return
    }

    await delay(200)
  }
}

async function extractClaudeConversation() {
  await waitForClaudeMessages()

  const embedded = extractFromEmbeddedJson()
  if (embedded?.messages.length && validateMessages(embedded.messages).ok) {
    return embedded
  }

  return extractFromDOM()
}

chrome.runtime.onMessage.addListener((msg: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
  if (msg.type === 'EXTRACT_CONVERSATION') {
    void extractClaudeConversation()
      .then((result) => {
        console.log(`[Codex Modified Container] Claude extracted ${result.messages.length} messages`)
        sendResponse(result)
      })
      .catch((error) => {
        sendResponse({
          messages: [],
          sourceTitle: getSourceTitle(),
          error: error instanceof Error ? error.message : 'Claude extraction failed',
        })
      })
  }
  return true
})

console.log('[Codex Modified Container] Claude extractor loaded on', window.location.href)
