import {
  normalizeIncomingMessages,
  normalizeImportedConversation,
  upsertImportedConversation,
} from '../lib/conversation'
import { db } from '../storage/db'
import type { Container, ImportedConversation, RunLogEntry } from '../types'

type ExtractedMessage = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
}

type ExtractResult = {
  messages?: ExtractedMessage[]
  sourceUrl?: string
  sourceTitle?: string
  error?: string
}

const AUTO_REFRESH_ALARM = 'codex-container-auto-refresh'
const AUTO_REFRESH_INTERVAL_MINUTES = 15

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isGeminiShareUrl(url?: string) {
  return Boolean(url && /gemini\.google\.com\/share\//.test(url))
}

function isChatGPTShareUrl(url?: string) {
  return Boolean(url && /(chatgpt\.com|chat\.openai\.com)\/share\//.test(url))
}

function isClaudeShareUrl(url?: string) {
  return Boolean(url && /claude\.ai\/share\//.test(url))
}

function isLikelyPartialExtraction(url: string | undefined, messages: ExtractedMessage[] | undefined) {
  if (!messages?.length) return true
  if (
    (isGeminiShareUrl(url) || isClaudeShareUrl(url) || isChatGPTShareUrl(url))
    && (!messages.some((message) => message.role === 'assistant') || messages.length < 2)
  ) {
    return true
  }
  return false
}

function genericExtractConversation() {
  const cleanText = (value: string) =>
    value
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  const uniqueBlocks = (blocks: string[]) => {
    const result: string[] = []
    for (const block of blocks) {
      if (!block || block.length < 20) continue
      if (result.some((existing) => existing.includes(block) || block.includes(existing))) continue
      result.push(block)
    }
    return result
  }

  const inferRoleFromElement = (element: Element, index: number): 'user' | 'assistant' => {
    const fingerprint = [
      element.getAttribute('data-testid'),
      element.getAttribute('data-message-author-role'),
      element.getAttribute('aria-label'),
      (element as HTMLElement).className,
      (element as HTMLElement).innerText?.slice(0, 120),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    if (
      /\b(user|human|query|prompt|question|ask|me)\b/.test(fingerprint) ||
      fingerprint.includes('user-query')
    ) {
      return 'user'
    }

    if (
      /\b(assistant|model|answer|response|reply|bot|ai|chatgpt|gemini|claude|manus)\b/.test(fingerprint) ||
      fingerprint.includes('model-response')
    ) {
      return 'assistant'
    }

    return index % 2 === 0 ? 'user' : 'assistant'
  }

  const messageNodes = document.querySelectorAll('[data-message-author-role]')
  if (messageNodes.length > 0) {
    return Array.from(messageNodes)
      .map((node, index) => {
        const role = node.getAttribute('data-message-author-role')
        const content = cleanText((node as HTMLElement).innerText || '')
        if ((role !== 'user' && role !== 'assistant') || !content) return null
        return {
          id: `generic-${index}-${Date.now()}`,
          role,
          content,
          timestamp: new Date().toISOString(),
        }
      })
      .filter(Boolean)
  }

  const roleAwareNodes = Array.from(
    document.querySelectorAll(
      'main article, main [data-testid*="message"], main [class*="message"], main [class*="response"], main [class*="query"]',
    ),
  )

  const roleAwareMessages = roleAwareNodes
    .map((node, index) => {
      const content = cleanText((node as HTMLElement).innerText || '')
      if (!content || content.length < 20) return null
      return {
        id: `generic-role-${index}-${Date.now()}`,
        role: inferRoleFromElement(node, index),
        content,
        timestamp: new Date().toISOString(),
      }
    })
    .filter(Boolean)

  if (roleAwareMessages.length > 1) {
    return roleAwareMessages
  }

  const main = document.querySelector('main') || document.body
  const blocks = uniqueBlocks(
    Array.from(main.querySelectorAll('article, section, div, p, li'))
      .filter((node) => (node as HTMLElement).children.length < 5)
      .map((node) => cleanText((node as HTMLElement).innerText || '')),
  )

  return blocks.map((content, index) => ({
    id: `generic-${index}-${Date.now()}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
    timestamp: new Date().toISOString(),
  }))
}

function cleanSourceTitle(value?: string) {
  if (!value) return undefined

  return value
    .replace(/^[\u200e\u200f\u202a-\u202e]+/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/^\s*(ChatGPT|Gemini|Claude)\s*[-:：|]\s*/i, '')
    .replace(/\s*[-|:：]\s*(ChatGPT|Gemini|Claude)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || undefined
}

function createRunLog(message: string, level: RunLogEntry['level']): RunLogEntry {
  return {
    id: crypto.randomUUID(),
    level,
    message,
    timestamp: new Date().toISOString(),
  }
}

function notifyContainersUpdated() {
  chrome.runtime.sendMessage({ type: 'CONTAINERS_UPDATED' }, () => {
    void chrome.runtime.lastError
  })
}

async function syncAutoRefreshAlarm() {
  const containers = await db.containers.getAll()
  const hasEnabledContainer = containers.some((container) => container.autoRefresh?.enabled)

  if (hasEnabledContainer) {
    chrome.alarms.create(AUTO_REFRESH_ALARM, {
      periodInMinutes: AUTO_REFRESH_INTERVAL_MINUTES,
    })
    return
  }

  chrome.alarms.clear(AUTO_REFRESH_ALARM)
}

function extractSourceTitleFromTab(tabId: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      const fallbackTitle = cleanSourceTitle(tab.title)

      chrome.tabs.sendMessage(
        tabId,
        { type: 'EXTRACT_CONVERSATION' },
        (response: { sourceTitle?: string } | undefined) => {
          if (chrome.runtime.lastError) {
            resolve(fallbackTitle)
            return
          }

          resolve(cleanSourceTitle(response?.sourceTitle) || fallbackTitle)
        },
      )
    })
  })
}

function extractFromTabOnce(tabId: number): Promise<ExtractResult> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      const sourceUrl = tab.url
      const sourceTitle = cleanSourceTitle(tab.title)

      chrome.tabs.sendMessage(
        tabId,
        { type: 'EXTRACT_CONVERSATION' },
        (response: { messages?: ExtractedMessage[]; sourceTitle?: string } | undefined) => {
        if (!chrome.runtime.lastError && response?.messages?.length) {
          resolve({
            sourceUrl,
            sourceTitle: cleanSourceTitle(response.sourceTitle) || sourceTitle,
            messages: response.messages,
          })
          return
        }

        chrome.scripting.executeScript(
          {
            target: { tabId },
            func: genericExtractConversation,
          },
          (results) => {
            if (chrome.runtime.lastError) {
              resolve({ sourceUrl, sourceTitle, error: chrome.runtime.lastError.message })
              return
            }

            const messages = (results?.[0]?.result as ExtractedMessage[] | undefined) ?? []
            if (messages.length === 0) {
              resolve({ sourceUrl, sourceTitle, error: '页面没有提取到可用内容' })
              return
            }

            resolve({ sourceUrl, sourceTitle, messages })
          },
        )
      },
      )
    })
  })
}

async function extractFromTab(tabId: number): Promise<ExtractResult> {
  let lastResult = await extractFromTabOnce(tabId)

  if (!isLikelyPartialExtraction(lastResult.sourceUrl, lastResult.messages)) {
    return lastResult
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleep(1500)
    lastResult = await extractFromTabOnce(tabId)
    if (!isLikelyPartialExtraction(lastResult.sourceUrl, lastResult.messages)) {
      return lastResult
    }
  }

  return lastResult
}

function openAndExtractUrl(url: string): Promise<ExtractResult> {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab?.id) {
        resolve({ error: '无法打开目标链接' })
        return
      }

      const tabId = tab.id
      chrome.tabs.onUpdated.addListener(function listener(updatedId, info) {
        if (updatedId !== tabId || info.status !== 'complete') return
        chrome.tabs.onUpdated.removeListener(listener)

        setTimeout(async () => {
          const result = await extractFromTab(tabId)
          chrome.tabs.remove(tabId).catch(() => {})
          resolve(result)
        }, 3500)
      })
    })
  })
}

async function refreshConversationInContainer(
  container: Container,
  conversation: ImportedConversation,
) {
  if (!conversation.source.url) {
    return {
      conversation,
      mode: 'unchanged' as const,
      addedMessages: 0,
      sourceUrl: undefined,
    }
  }

  const result = await openAndExtractUrl(conversation.source.url)

  if (result.error) {
    throw new Error(result.error)
  }

  const drafts = normalizeIncomingMessages(result.messages ?? [])
  const next = upsertImportedConversation({
    containerName: container.name,
    drafts,
    sourceValue: result.sourceUrl ?? conversation.source.url,
    sourceTitle: result.sourceTitle,
    existingConversation: conversation,
  })

  return {
    ...next,
    sourceUrl: result.sourceUrl ?? conversation.source.url,
  }
}

async function refreshContainerById(containerId: string) {
  const container = await db.containers.get(containerId)
  if (!container) {
    return { checked: 0, updated: 0, addedMessages: 0 }
  }

  const history = (container.importHistory?.length
    ? container.importHistory
    : container.importedConversation
      ? [container.importedConversation]
      : []).map((conversation) => normalizeImportedConversation(conversation))

  const now = new Date().toISOString()
  const nextRunAt = new Date(Date.now() + AUTO_REFRESH_INTERVAL_MINUTES * 60_000).toISOString()

  if (history.length === 0) {
    await db.containers.put({
      ...container,
      autoRefresh: container.autoRefresh
        ? {
            ...container.autoRefresh,
            nextRunAt,
            lastCheckedAt: now,
          }
        : container.autoRefresh,
      updatedAt: container.updatedAt,
    })
    return { checked: 0, updated: 0, addedMessages: 0 }
  }

  let nextHistory = history
  let updatedConversations = 0
  let addedMessages = 0
  let hasRecordChanges = false
  const logs: RunLogEntry[] = []

  for (const conversation of history) {
    if (!conversation.source.url) continue

    try {
      const refreshed = await refreshConversationInContainer(container, conversation)

      if (refreshed.mode === 'unchanged') {
        continue
      }

      hasRecordChanges = true
      nextHistory = nextHistory.map((item) => (item.id === conversation.id ? refreshed.conversation : item))

      if (refreshed.addedMessages > 0) {
        updatedConversations += 1
        addedMessages += refreshed.addedMessages
        logs.unshift(
          createRunLog(
            `自动更新成功：${refreshed.conversation.customTitle || refreshed.conversation.title} 新增 ${refreshed.addedMessages} 条消息`,
            'success',
          ),
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      logs.unshift(
        createRunLog(
          `自动更新失败：${conversation.source.url}，原因：${message}`,
          'error',
        ),
      )
    }
  }

  const nextAutoRefresh = container.autoRefresh
    ? {
        ...container.autoRefresh,
        enabled: true,
        intervalMinutes: AUTO_REFRESH_INTERVAL_MINUTES,
        nextRunAt,
        lastCheckedAt: now,
        lastUpdatedAt: addedMessages > 0 ? now : container.autoRefresh.lastUpdatedAt,
      }
    : undefined

  const nextContainer: Container = {
    ...container,
    importedConversation: nextHistory.at(-1),
    importHistory: nextHistory,
    runLogs: [...logs, ...(container.runLogs ?? [])].slice(0, 120),
    autoRefresh: nextAutoRefresh,
    updatedAt: hasRecordChanges || logs.length > 0 ? Date.now() : container.updatedAt,
  }

  await db.containers.put(nextContainer)
  if (hasRecordChanges || logs.length > 0 || container.autoRefresh?.enabled) {
    notifyContainersUpdated()
  }

  return {
    checked: history.length,
    updated: updatedConversations,
    addedMessages,
  }
}

async function refreshAllEnabledContainers() {
  const containers = await db.containers.getAll()
  const enabledContainers = containers.filter((container) => container.autoRefresh?.enabled)

  for (const container of enabledContainers) {
    await refreshContainerById(container.id)
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_REFRESH_ALARM) {
    void refreshAllEnabledContainers()
  }
})

chrome.runtime.onInstalled.addListener(() => {
  void syncAutoRefreshAlarm()
})

chrome.runtime.onStartup.addListener(() => {
  void syncAutoRefreshAlarm()
})

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id })
  }
})

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id
      if (!tabId) {
        sendResponse({ error: '无法获取当前标签页' })
        return
      }
      sendResponse(await extractFromTab(tabId))
    })
    return true
  }

  if (message.type === 'OPEN_AND_EXTRACT') {
    const url = String(message.url || '')
    void openAndExtractUrl(url).then((result) => {
      sendResponse(result)
    })
    return true
  }

  if (message.type === 'FETCH_SOURCE_TITLE') {
    const url = String(message.url || '')
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab?.id) {
        sendResponse({ error: '无法打开目标链接' })
        return
      }

      const tabId = tab.id
      chrome.tabs.onUpdated.addListener(function listener(updatedId, info) {
        if (updatedId !== tabId || info.status !== 'complete') return
        chrome.tabs.onUpdated.removeListener(listener)

        setTimeout(async () => {
          const sourceTitle = await extractSourceTitleFromTab(tabId)
          chrome.tabs.remove(tabId).catch(() => {})
          sendResponse({ sourceTitle })
        }, 1500)
      })
    })
    return true
  }

  if (message.type === 'SYNC_AUTO_REFRESH') {
    void syncAutoRefreshAlarm().then(() => {
      sendResponse({ ok: true })
    })
    return true
  }

  if (message.type === 'REFRESH_CONTAINER_NOW') {
    const containerId = String(message.containerId || '')
    void refreshContainerById(containerId).then((result) => {
      sendResponse(result)
    })
    return true
  }

  return true
})

console.log('[Codex Modified Container] Background service worker started')
