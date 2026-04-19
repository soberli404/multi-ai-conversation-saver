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
          const result = await extractFromTab(tabId)
          chrome.tabs.remove(tabId).catch(() => {})
          sendResponse(result)
        }, 3500)
      })
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

  return true
})

console.log('[Codex Modified Container] Background service worker started')
