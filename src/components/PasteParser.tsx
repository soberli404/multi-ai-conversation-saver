import { useState } from 'react'
import { normalizeIncomingMessages, parseConversationText } from '../lib/conversation'
import type { Container, MessageDraft, RunLogLevel } from '../types'

interface ExtractResponse {
  messages?: Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp?: string }>
  sourceUrl?: string
  sourceTitle?: string
  platform?: string
  error?: string
}

function extractFromActiveTab(): Promise<{ sourceUrl?: string; sourceTitle?: string; messages: MessageDraft[] }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'EXTRACT_ACTIVE_TAB' }, (response: ExtractResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (response?.error) {
        reject(new Error(response.error))
      } else if (response?.messages?.length) {
        resolve({
          sourceUrl: response.sourceUrl,
          sourceTitle: response.sourceTitle,
          messages: normalizeIncomingMessages(response.messages),
        })
      } else {
        reject(new Error('当前页面没有提取到可用内容'))
      }
    })
  })
}

function extractFromUrl(url: string): Promise<{ sourceUrl?: string; sourceTitle?: string; messages: MessageDraft[] }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'OPEN_AND_EXTRACT', url }, (response: ExtractResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (response?.error) {
        reject(new Error(response.error))
      } else if (response?.messages?.length) {
        resolve({
          sourceUrl: response.sourceUrl ?? url,
          sourceTitle: response.sourceTitle,
          messages: normalizeIncomingMessages(response.messages),
        })
      } else {
        reject(new Error('链接没有提取到可用内容'))
      }
    })
  })
}

interface Props {
  container: Container
  onClose: () => void
  onSave: (messages: MessageDraft[], sourceValue?: string, sourceTitle?: string) => Promise<'created' | 'updated'>
  onLog: (message: string, level?: RunLogLevel) => Promise<void>
}

function getActiveTabUrl(): Promise<string | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.url)
    })
  })
}

export function PasteParser({ container, onClose, onSave, onLog }: Props) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const parseInput = async () => {
    const trimmed = input.trim()
    if (!trimmed) return

    setError('')
    setLoading(true)

    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        await onLog(`开始导入链接：${trimmed}`)
        const result = await extractFromUrl(trimmed)
        const mode = await onSave(result.messages, result.sourceUrl ?? trimmed, result.sourceTitle)
        if (mode === 'updated') {
          await onLog(`链接已存在，已更新原记录：${result.sourceUrl ?? trimmed}`, 'warning')
        } else {
          await onLog(`导入完成：${result.sourceUrl ?? trimmed}，共 ${result.messages.length} 条消息`, 'success')
        }
      } else {
        await onLog('开始导入粘贴文本')
        const messages = parseConversationText(trimmed)
        if (messages.length === 0) {
          throw new Error('没有识别到对话结构，请确认文本里包含消息内容。')
        }
        await onSave(messages)
        await onLog(`导入完成：粘贴文本，共 ${messages.length} 条消息`, 'success')
      }

      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : '导入失败'
      setError(message)
      await onLog(`导入失败：${trimmed}，原因：${message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const parseCurrentPage = async () => {
    setError('')
    setLoading(true)
    const activeUrl = await getActiveTabUrl()

    try {
      await onLog('开始抓取当前页面')
      const result = await extractFromActiveTab()
      const mode = await onSave(result.messages, result.sourceUrl, result.sourceTitle)
      if (mode === 'updated') {
        await onLog(`链接已存在，已更新原记录：${result.sourceUrl ?? activeUrl ?? '当前页面'}`, 'warning')
      } else {
        await onLog(`抓取完成：${result.sourceUrl ?? '当前页面'}，共 ${result.messages.length} 条消息`, 'success')
      }
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : '页面抓取失败'
      setError(message)
      await onLog(`抓取失败：${activeUrl ?? '当前页面'}，原因：${message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="detail-shell">
      <header className="page-header">
        <div>
          <button type="button" className="back-link" onClick={onClose}>
            返回详情页
          </button>
          <p className="eyebrow">统一导入</p>
          <h1 className="page-title">{container.name}</h1>
          <p className="page-subtitle">
            一个入口处理链接和文本。解析成功后会直接把整段对话导入当前容器，不再弹出预览和手动确认。
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">从当前页面抓取</h2>
            <p className="panel-meta">如果你当前就在聊天页或目标网页上，可以直接抓取并自动导入。</p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => void parseCurrentPage()}
          disabled={loading}
        >
          {loading ? '正在抓取并导入...' : '抓取当前页面并导入'}
        </button>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">链接或复制文本</h2>
            <p className="panel-meta">贴链接会自动识别来源；贴文本会按对话结构切分，并直接导入到容器。</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">输入内容</span>
          <textarea
            className="field-input field-textarea import-textarea"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              'https://chatgpt.com/share/...\nhttps://gemini.google.com/share/...\nhttps://claude.ai/share/...\nhttps://manus.im/...\n\n或直接粘贴聊天文本'
            }
          />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="button-row">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void parseInput()}
            disabled={!input.trim() || loading}
          >
            {loading ? '正在解析并导入...' : '直接导入到容器'}
          </button>
        </div>
      </section>
    </div>
  )
}
