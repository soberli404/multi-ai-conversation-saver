import type {
  ConversationStats,
  ConversationMessage,
  ImportedConversation,
  ImportedConversationSection,
  ImportedMessage,
  ImportedTurn,
  ImportResult,
  MessageDraft,
  MessageRole,
  Platform,
} from '../types'

export function detectPlatformFromText(input: string): Platform {
  const value = input.trim().toLowerCase()

  if (value.startsWith('http://') || value.startsWith('https://')) {
    if (value.includes('chatgpt.com') || value.includes('chat.openai.com')) return 'chatgpt'
    if (value.includes('gemini.google.com') || value.includes('g.co/gemini')) return 'gemini'
    if (value.includes('claude.ai')) return 'claude'
    if (value.includes('manus.im') || value.includes('manus.ai')) return 'manus'
    return 'web'
  }

  return 'text'
}

export function summarizeContent(content: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, '代码片段')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return '空消息'
  if (normalized.length <= 48) return normalized
  return `${normalized.slice(0, 48)}...`
}

export function cleanConversationSourceTitle(value?: string) {
  if (!value) return undefined

  const normalized = value
    .replace(/^[\u200e\u200f\u202a-\u202e]+/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^\s*(ChatGPT|Gemini|Claude)\s*[-:：|]\s*/i, '')
    .replace(/\s*[-|:：]\s*(ChatGPT|Gemini|Claude)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return undefined
  if (/^(chatgpt|gemini|claude)$/i.test(normalized)) return undefined
  if (/^new chat$/i.test(normalized)) return undefined
  return normalized
}

export function isPreferredConversationTitle(value?: string) {
  const normalized = cleanConversationSourceTitle(value)
  if (!normalized) return false

  if (/^(google gemini|gemini|chatgpt|claude)$/i.test(normalized)) return false
  if (/(customize chats|projects|artifacts|free plan|pro plan|settings|usage)/i.test(normalized)) return false

  return true
}

export function deriveConversationTitle(options: {
  customTitle?: string
  sourceTitle?: string
  userSummary?: string
  assistantSummary?: string
  sourceUrl?: string
  fallbackTitle?: string
}) {
  const {
    customTitle,
    sourceTitle,
    userSummary,
    assistantSummary,
    sourceUrl,
    fallbackTitle,
  } = options

  if (customTitle?.trim()) return customTitle.trim()
  if (isPreferredConversationTitle(sourceTitle)) {
    return cleanConversationSourceTitle(sourceTitle) as string
  }

  if (userSummary?.trim()) return userSummary.trim()
  if (assistantSummary?.trim()) return assistantSummary.trim()

  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl)
      return url.hostname.replace(/^www\./, '')
    } catch {
      return sourceUrl
    }
  }

  return fallbackTitle || '未命名对话'
}

export function normalizeConversationSourceUrl(value?: string) {
  if (!value) return undefined

  try {
    const url = new URL(value.trim())
    url.hash = ''
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.origin}${pathname}${url.search}`
  } catch {
    return value.trim()
  }
}

export function createDraftMessage(role: MessageRole, content: string, timestamp = new Date().toISOString()): MessageDraft {
  return {
    id: crypto.randomUUID(),
    role,
    content: content.trim(),
    summary: summarizeContent(content),
    timestamp,
    selected: true,
  }
}

export function parseConversationText(text: string): MessageDraft[] {
  const lines = text.split('\n')
  const rolePatterns: { pattern: RegExp; role: MessageRole }[] = [
    {
      pattern: /^(?:[#>*\-\s]*)(?:\*\*)?(?:You|User|Me|我|用户|Human|Question|Prompt|请求|提问)(?:\*\*)?\s*[:：]\s*/i,
      role: 'user',
    },
    {
      pattern: /^(?:[#>*\-\s]*)(?:\*\*)?(?:ChatGPT|GPT|Gemini|Claude|AI|Assistant|助手|Manus|Codex|Answer|Response|Reply|回答|回复|模型)(?:\*\*)?\s*[:：]\s*/i,
      role: 'assistant',
    },
  ]

  const drafts: MessageDraft[] = []
  let currentRole: MessageRole | null = null
  let currentContent: string[] = []
  let usedPrefixes = false

  const flush = () => {
    if (!currentRole) return
    const content = currentContent.join('\n').trim()
    if (!content) return
    drafts.push(createDraftMessage(currentRole, content))
  }

  for (const line of lines) {
    let matched = false

    for (const { pattern, role } of rolePatterns) {
      const match = line.match(pattern)
      if (!match) continue
      flush()
      currentRole = role
      currentContent = [line.slice(match[0].length)]
      usedPrefixes = true
      matched = true
      break
    }

    if (!matched) {
      currentContent.push(line)
    }
  }

  flush()

  if (usedPrefixes) {
    const hasAssistant = drafts.some((draft) => draft.role === 'assistant')
    if (!hasAssistant && drafts.length > 1) {
      return drafts.map((draft, index) => ({
        ...draft,
        role: index % 2 === 0 ? 'user' : 'assistant',
      }))
    }
    return drafts
  }

  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  if (blocks.length === 0) return []
  if (blocks.length === 1) return [createDraftMessage('assistant', blocks[0])]

  return blocks.map((block, index) => createDraftMessage(index % 2 === 0 ? 'user' : 'assistant', block))
}

export function normalizeIncomingMessages(
  messages: Array<{ id?: string; role: MessageRole; content: string; timestamp?: string }>,
): MessageDraft[] {
  const drafts = messages
    .map((message) => ({
      id: message.id ?? crypto.randomUUID(),
      role: message.role,
      content: message.content.trim(),
      summary: summarizeContent(message.content),
      timestamp: message.timestamp ?? new Date().toISOString(),
      selected: true,
    }))
    .filter((message) => message.content.length > 0)

  return normalizeConversationDrafts(drafts)
}

export function toStoredMessages(containerId: string, drafts: MessageDraft[]): ConversationMessage[] {
  const now = Date.now()
  return normalizeConversationDrafts(drafts).map((draft, index) => ({
    id: draft.id,
    containerId,
    index,
    role: draft.role,
    content: draft.content.trim(),
    summary: draft.summary.trim() || summarizeContent(draft.content),
    timestamp: draft.timestamp,
    createdAt: now,
    updatedAt: now,
  }))
}

export function parseInputToImportResult(input: string): ImportResult | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const platform = detectPlatformFromText(trimmed)
  if (platform !== 'text') {
    return {
      platform,
      sourceUrl: trimmed,
      messages: [],
    }
  }

  return {
    platform,
    messages: parseConversationText(trimmed),
  }
}

function looksLikeUserMessage(content: string) {
  const normalized = content.trim()
  return /^(?:你说|我说|用户|user|human|question|prompt)[\s:：\n]/i.test(normalized)
}

function looksLikeAssistantMessage(content: string) {
  const normalized = content.trim()
  return /^(?:经过联网检索|关于|以下是|当然|可以|好的|Sure|Here is|Here are|根据|结论|明确判定)/i.test(normalized)
}

export function normalizeConversationDrafts(drafts: MessageDraft[]): MessageDraft[] {
  const repaired = drafts.map((draft) => {
    if (
      draft.role === 'user'
      && !looksLikeUserMessage(draft.content)
      && (looksLikeAssistantMessage(draft.content) || draft.content.length > 280)
    ) {
      return {
        ...draft,
        role: 'assistant' as const,
      }
    }

    if (draft.role === 'assistant' && looksLikeUserMessage(draft.content)) {
      return {
        ...draft,
        role: 'user' as const,
      }
    }

    return draft
  })

  const firstAssistantIndex = repaired.findIndex((draft) => draft.role === 'assistant')
  const hasUserPrefixThenAssistantSuffix =
    firstAssistantIndex > 0
    && repaired.slice(0, firstAssistantIndex).every((draft) => draft.role === 'user')
    && repaired.slice(firstAssistantIndex).every((draft) => draft.role === 'assistant')

  if (hasUserPrefixThenAssistantSuffix) {
    const users = repaired.filter((draft) => draft.role === 'user')
    const assistants = repaired.filter((draft) => draft.role === 'assistant')
    const interleaved: MessageDraft[] = []
    const maxLength = Math.max(users.length, assistants.length)

    for (let index = 0; index < maxLength; index += 1) {
      if (users[index]) interleaved.push(users[index])
      if (assistants[index]) interleaved.push(assistants[index])
    }

    return interleaved
  }

  return repaired
}

export function buildImportedMessages(drafts: MessageDraft[]): ImportedMessage[] {
  return normalizeConversationDrafts(drafts).map((draft, index) => ({
    id: draft.id,
    index,
    role: draft.role,
    content: draft.content,
    summary: draft.summary,
    timestamp: draft.timestamp,
  }))
}

export function buildImportedTurns(messages: ImportedMessage[]): ImportedTurn[] {
  const turns: ImportedTurn[] = []

  const appendTurn = (turn: ImportedTurn) => {
    turns.push({
      ...turn,
      index: turns.length,
    })
  }

  const userMessages = messages.filter((message) => message.role === 'user')
  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const isGroupedByRole =
    messages.length > 1
    && userMessages.length > 0
    && assistantMessages.length > 0
    && messages.findIndex((message) => message.role === 'assistant') > 0
    && messages
      .slice(messages.findIndex((message) => message.role === 'assistant'))
      .every((message) => message.role === 'assistant')

  if (isGroupedByRole) {
    const maxLength = Math.max(userMessages.length, assistantMessages.length)
    for (let index = 0; index < maxLength; index += 1) {
      appendTurn({
        id: crypto.randomUUID(),
        index,
        user: userMessages[index],
        assistant: assistantMessages[index],
      })
    }
    return turns
  }

  let currentTurn: ImportedTurn | null = null

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentTurn) appendTurn(currentTurn)
      currentTurn = {
        id: crypto.randomUUID(),
        index: turns.length,
        user: message,
      }
      continue
    }

    if (!currentTurn) {
      currentTurn = {
        id: crypto.randomUUID(),
        index: turns.length,
        assistant: message,
      }
      continue
    }

    if (!currentTurn.assistant) {
      currentTurn = {
        ...currentTurn,
        assistant: message,
      }
      appendTurn(currentTurn)
      currentTurn = null
      continue
    }

    appendTurn(currentTurn)
    currentTurn = {
      id: crypto.randomUUID(),
      index: turns.length,
      assistant: message,
    }
  }

  if (currentTurn) appendTurn(currentTurn)

  return turns
}

export function flattenConversationTurns(conversation: ImportedConversation): ImportedTurn[] {
  const normalized = normalizeImportedConversation(conversation)
  const allTurns = [
    ...normalized.turns,
    ...(normalized.sections ?? []).flatMap((section) => section.turns),
  ]

  return allTurns.map((turn, index) => ({
    ...turn,
    index,
  }))
}

export function flattenConversationMessages(conversation: ImportedConversation): ImportedMessage[] {
  const messages = flattenConversationTurns(conversation).flatMap((turn) => {
    const items: ImportedMessage[] = []
    if (turn.user) items.push(turn.user)
    if (turn.assistant) items.push(turn.assistant)
    return items
  })

  return messages.map((message, index) => ({
    ...message,
    index,
  }))
}

export function calculateConversationStats(turns: ImportedTurn[]): ConversationStats {
  const messages = turns.flatMap((turn) => [turn.user, turn.assistant].filter(Boolean) as ImportedMessage[])

  return {
    messageCount: messages.length,
    userCount: messages.filter((message) => message.role === 'user').length,
    assistantCount: messages.filter((message) => message.role === 'assistant').length,
  }
}

function buildConversationSection(turns: ImportedTurn[], index: number, importedAt: string): ImportedConversationSection {
  return {
    id: crypto.randomUUID(),
    index,
    title: `第 ${index + 1} 次更新`,
    importedAt,
    turns: turns.map((turn, turnIndex) => ({
      ...turn,
      index: turnIndex,
    })),
    stats: calculateConversationStats(turns),
  }
}

function messageSignature(message: ImportedMessage) {
  return `${message.role}\n${message.content.trim()}`
}

function getAppendedMessages(existingMessages: ImportedMessage[], nextMessages: ImportedMessage[]) {
  const existingSignatures = existingMessages.map(messageSignature)
  const nextSignatures = nextMessages.map(messageSignature)

  const sameLengthAndSameOrder =
    existingSignatures.length === nextSignatures.length
    && existingSignatures.every((signature, index) => signature === nextSignatures[index])

  if (sameLengthAndSameOrder) {
    return []
  }

  if (
    nextSignatures.length > existingSignatures.length
    && existingSignatures.every((signature, index) => signature === nextSignatures[index])
  ) {
    return nextMessages.slice(existingMessages.length)
  }

  return null
}

function summarizeTurns(turns: ImportedTurn[]) {
  const userSummary = turns.find((turn) => turn.user?.summary)?.user?.summary
  const assistantSummary = turns.find((turn) => turn.assistant?.summary)?.assistant?.summary
  return { userSummary, assistantSummary }
}

function buildConversationTitle(
  customTitle: string | undefined,
  sourceTitle: string | undefined,
  sourceUrl: string | undefined,
  turns: ImportedTurn[],
  fallbackTitle: string,
) {
  const { userSummary, assistantSummary } = summarizeTurns(turns)
  return deriveConversationTitle({
    customTitle,
    sourceTitle,
    userSummary,
    assistantSummary,
    sourceUrl,
    fallbackTitle,
  })
}

export function upsertImportedConversation(options: {
  containerName: string
  drafts: MessageDraft[]
  sourceValue?: string
  sourceTitle?: string
  existingConversation?: ImportedConversation
}): {
  conversation: ImportedConversation
  mode: 'created' | 'updated' | 'unchanged'
  addedMessages: number
} {
  const {
    containerName,
    drafts,
    sourceValue,
    sourceTitle,
    existingConversation,
  } = options

  const platform = sourceValue ? detectPlatformFromText(sourceValue) : 'text'
  const cleanedSourceTitle = cleanConversationSourceTitle(sourceTitle)
  const importedMessages = buildImportedMessages(drafts)
  const importedTurns = buildImportedTurns(importedMessages)
  const importedAt = new Date().toISOString()

  if (!existingConversation) {
    const title = buildConversationTitle(
      undefined,
      cleanedSourceTitle,
      sourceValue?.trim(),
      importedTurns,
      containerName,
    )

    return {
      conversation: {
        id: crypto.randomUUID(),
        schemaVersion: '2.1',
        title,
        source: {
          platform,
          url: sourceValue?.trim() || undefined,
          title: cleanedSourceTitle,
          importedAt,
        },
        turns: importedTurns,
        sections: [],
        stats: calculateConversationStats(importedTurns),
      },
      mode: 'created',
      addedMessages: importedMessages.length,
    }
  }

  const current = normalizeImportedConversation(existingConversation)
  const existingMessages = flattenConversationMessages(current)
  const appendedMessages = getAppendedMessages(existingMessages, importedMessages)
  const nextSourceTitle = cleanedSourceTitle ?? current.source.title
  const nextImportedAt = current.source.importedAt || importedAt
  const nextSourceUrl = sourceValue?.trim() || current.source.url

  const rebuildConversation = (turns: ImportedTurn[], sections: ImportedConversationSection[], mode: 'updated' | 'unchanged', addedMessages: number) => {
    const title = buildConversationTitle(
      current.customTitle,
      nextSourceTitle,
      nextSourceUrl,
      turns,
      current.title || containerName,
    )

    const aggregateTurns = [
      ...turns,
      ...sections.flatMap((section) => section.turns),
    ].map((turn, index) => ({
      ...turn,
      index,
    }))

    return {
      conversation: {
        ...current,
        schemaVersion: '2.1' as const,
        title,
        source: {
          ...current.source,
          platform,
          url: nextSourceUrl,
          title: nextSourceTitle,
          importedAt: nextImportedAt,
        },
        turns,
        sections,
        stats: calculateConversationStats(aggregateTurns),
      },
      mode,
      addedMessages,
    }
  }

  if (appendedMessages && appendedMessages.length > 0) {
    const appendedTurns = buildImportedTurns(appendedMessages)
    const sections = [
      ...(current.sections ?? []),
      buildConversationSection(appendedTurns, current.sections?.length ?? 0, importedAt),
    ]
    return rebuildConversation(current.turns, sections, 'updated', appendedMessages.length)
  }

  const incomingStats = calculateConversationStats(importedTurns)
  const shouldReplaceBrokenConversation =
    current.stats.assistantCount === 0
    && incomingStats.assistantCount > 0
    && importedMessages.length >= existingMessages.length

  if (shouldReplaceBrokenConversation) {
    return rebuildConversation(importedTurns, [], 'updated', importedMessages.length)
  }

  const title = buildConversationTitle(
    current.customTitle,
    nextSourceTitle,
    nextSourceUrl,
    current.turns,
    current.title || containerName,
  )

  const hasMetadataChange =
    title !== current.title
    || nextSourceTitle !== current.source.title
    || nextSourceUrl !== current.source.url
    || platform !== current.source.platform

  return {
    conversation: {
      ...current,
      schemaVersion: '2.1',
      title,
      source: {
        ...current.source,
        platform,
        url: nextSourceUrl,
        title: nextSourceTitle,
        importedAt: nextImportedAt,
      },
    },
    mode: hasMetadataChange ? 'updated' : 'unchanged',
    addedMessages: 0,
  }
}

export function normalizeImportedConversation(conversation: ImportedConversation): ImportedConversation {
  if ((conversation.schemaVersion === '2.0' || conversation.schemaVersion === '2.1') && conversation.turns?.length) {
    const turns = conversation.turns.map((turn, index) => ({
      ...turn,
      index,
    }))
    const sections = (conversation.sections ?? []).map((section, sectionIndex) => ({
      ...section,
      index: sectionIndex,
      turns: section.turns.map((turn, turnIndex) => ({
        ...turn,
        index: turnIndex,
      })),
      stats: section.stats ?? calculateConversationStats(section.turns),
    }))
    const aggregateTurns = [
      ...turns,
      ...sections.flatMap((section) => section.turns),
    ].map((turn, index) => ({
      ...turn,
      index,
    }))

    return {
      ...conversation,
      schemaVersion: '2.1',
      source: {
        ...conversation.source,
        title: cleanConversationSourceTitle(conversation.source?.title),
      },
      turns,
      sections,
      stats: calculateConversationStats(aggregateTurns),
    }
  }

  const legacyMessages = conversation.conversation?.messages ?? []
  const normalizedMessages = normalizeConversationDrafts(
    legacyMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      summary: message.summary,
      timestamp: message.timestamp,
      selected: true,
    })),
  )

  const importedMessages = buildImportedMessages(normalizedMessages)
  const turns = buildImportedTurns(importedMessages)

  return {
    id: conversation.id,
    schemaVersion: '2.1',
    title: conversation.title || conversation.conversation?.title || '未命名对话',
    customTitle: conversation.customTitle,
    source: {
      ...conversation.source,
      title: cleanConversationSourceTitle(conversation.source?.title),
    },
    turns,
    sections: [],
    stats: calculateConversationStats(turns),
  }
}
