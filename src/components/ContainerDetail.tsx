import { useMemo, useState } from 'react'
import { db } from '../storage/db'
import {
  buildImportedMessages,
  buildImportedTurns,
  cleanConversationSourceTitle,
  deriveConversationTitle,
  detectPlatformFromText,
  normalizeImportedConversation,
  toStoredMessages,
} from '../lib/conversation'
import { PasteParser } from './PasteParser'
import type {
  Container,
  ImportedConversation,
  MessageDraft,
  RunLogEntry,
  RunLogLevel,
  Tag,
} from '../types'

interface Props {
  container: Container
  tags: Tag[]
  onBack: () => void
  onContainersReload: () => void
}

const PLATFORM_LABEL = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  manus: 'Manus',
  web: '网页',
  text: '文本',
}

function getImportHistory(container: Container): ImportedConversation[] {
  if (container.importHistory?.length) {
    return container.importHistory.map((item) => normalizeImportedConversation(item))
  }

  if (container.importedConversation) {
    return [normalizeImportedConversation(container.importedConversation)]
  }

  return []
}

function getRunLogs(container: Container): RunLogEntry[] {
  return [...(container.runLogs ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

function sanitizeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'container'
}

function normalizeSourceUrl(value?: string) {
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

function createImportTitle(containerName: string, drafts: MessageDraft[], sourceValue?: string, sourceTitle?: string) {
  const importedMessages = buildImportedMessages(drafts)
  const userDraft = importedMessages.find((draft) => draft.role === 'user' && draft.summary.trim())
  const assistantDraft = importedMessages.find((draft) => draft.role === 'assistant' && draft.summary.trim())

  return deriveConversationTitle({
    sourceTitle,
    userSummary: userDraft?.summary,
    assistantSummary: assistantDraft?.summary,
    sourceUrl: sourceValue,
    fallbackTitle: containerName,
  })
}

function getDisplayConversationTitle(conversation: ImportedConversation) {
  const userSummary = conversation.turns.find((turn) => turn.user?.summary)?.user?.summary
  const assistantSummary = conversation.turns.find((turn) => turn.assistant?.summary)?.assistant?.summary

  return deriveConversationTitle({
    sourceTitle: conversation.source.title,
    userSummary,
    assistantSummary,
    sourceUrl: conversation.source.url,
    fallbackTitle: conversation.title,
  })
}

export function ContainerDetail({
  container,
  tags,
  onBack,
  onContainersReload,
}: Props) {
  const [view, setView] = useState<'main' | 'import'>('main')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(container.name)

  const importHistory = useMemo(() => getImportHistory(container), [container])
  const runLogs = useMemo(() => getRunLogs(container), [container])
  const tagMap = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])

  const stats = useMemo(
    () => ({
      conversationCount: importHistory.length,
      messageCount: importHistory.reduce((sum, item) => sum + item.stats.messageCount, 0),
      latestPlatform:
        importHistory.at(-1)?.source.platform ?? container.importedConversation?.source.platform ?? container.platform,
    }),
    [container.importedConversation, container.platform, importHistory],
  )

  const updateContainer = async (updater: (current: Container) => Container) => {
    const stored = (await db.containers.get(container.id)) ?? container
    const next = updater(stored)
    await db.containers.put({
      ...next,
      updatedAt: Date.now(),
    })
    await onContainersReload()
  }

  const saveContainerTitle = async () => {
    const nextName = titleDraft.trim()
    if (!nextName || nextName === container.name) {
      setEditingTitle(false)
      setTitleDraft(container.name)
      return
    }

    await updateContainer((current) => ({
      ...current,
      name: nextName,
    }))

    setEditingTitle(false)
  }

  const appendRunLog = async (message: string, level: RunLogLevel = 'info') => {
    const entry: RunLogEntry = {
      id: crypto.randomUUID(),
      level,
      message,
      timestamp: new Date().toISOString(),
    }

    await updateContainer((current) => ({
      ...current,
      runLogs: [entry, ...(current.runLogs ?? [])].slice(0, 120),
    }))
  }

  const saveImportedMessages = async (
    drafts: MessageDraft[],
    sourceValue?: string,
    sourceTitle?: string,
  ): Promise<'created' | 'updated'> => {
    const platform = sourceValue ? detectPlatformFromText(sourceValue) : 'text'
    const importedMessages = buildImportedMessages(drafts)
    const importedTurns = buildImportedTurns(importedMessages)
    const cleanedSourceTitle = cleanConversationSourceTitle(sourceTitle)
    const normalizedSourceUrl = normalizeSourceUrl(sourceValue)
    const currentHistory = getImportHistory(container)
    const existingConversation = normalizedSourceUrl
      ? currentHistory.find((item) => normalizeSourceUrl(item.source.url) === normalizedSourceUrl)
      : undefined

    const importedConversation: ImportedConversation = {
      id: existingConversation?.id ?? crypto.randomUUID(),
      schemaVersion: '2.0',
      title: createImportTitle(container.name, drafts, sourceValue, cleanedSourceTitle),
      source: {
        platform,
        url: sourceValue?.trim() || undefined,
        title: cleanedSourceTitle ?? existingConversation?.source.title,
        importedAt: existingConversation?.source.importedAt ?? new Date().toISOString(),
      },
      turns: importedTurns,
      stats: {
        messageCount: importedMessages.length,
        userCount: importedMessages.filter((draft) => draft.role === 'user').length,
        assistantCount: importedMessages.filter((draft) => draft.role === 'assistant').length,
      },
    }

    await db.messages.replaceForContainer(container.id, toStoredMessages(container.id, drafts))

    await updateContainer((current) => ({
      ...current,
      platform,
      sourceUrl: sourceValue?.trim() || current.sourceUrl,
      importedConversation,
      importHistory: existingConversation
        ? getImportHistory(current).map((item) => (item.id === existingConversation.id ? importedConversation : item))
        : [...getImportHistory(current), importedConversation],
    }))

    return existingConversation ? 'updated' : 'created'
  }

  const clearImportedHistory = async () => {
    await Promise.all([
      db.messages.deleteByContainer(container.id),
      updateContainer((current) => ({
        ...current,
        importedConversation: undefined,
        importHistory: [],
        platform: 'text',
        sourceUrl: undefined,
      })),
    ])
  }

  const clearRunLogs = async () => {
    await updateContainer((current) => ({
      ...current,
      runLogs: [],
    }))
  }

  const downloadJson = () => {
    const summary = {
      conversationCount: importHistory.length,
      messageCount: importHistory.reduce((sum, conversation) => sum + conversation.stats.messageCount, 0),
      userMessageCount: importHistory.reduce((sum, conversation) => sum + conversation.stats.userCount, 0),
      assistantMessageCount: importHistory.reduce((sum, conversation) => sum + conversation.stats.assistantCount, 0),
      platforms: Array.from(new Set(importHistory.map((conversation) => conversation.source.platform))),
      lastImportedAt: importHistory.at(-1)?.source.importedAt,
    }

    const payload = {
      schemaVersion: '2.0',
      exportedAt: new Date().toISOString(),
      container: {
        id: container.id,
        name: container.name,
        platform: stats.latestPlatform,
        sourceUrl: container.sourceUrl,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
      },
      tags: container.tagIds
        .map((tagId) => tagMap.get(tagId))
        .filter((tag): tag is Tag => Boolean(tag))
        .map((tag) => ({
          id: tag.id,
          name: tag.name,
          category: tag.category,
        })),
      summary,
      conversations: importHistory.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        source: conversation.source,
        turns: conversation.turns,
        stats: conversation.stats,
      })),
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${sanitizeFileName(container.name)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (view === 'import') {
    return (
      <PasteParser
        container={container}
        onClose={() => setView('main')}
        onSave={saveImportedMessages}
        onLog={appendRunLog}
      />
    )
  }

  return (
    <div className="detail-shell">
      <header className="page-header">
        <div>
          <button type="button" className="back-link" onClick={onBack}>
            返回容器列表
          </button>
          <p className="eyebrow">对话资产归档</p>
          {editingTitle ? (
            <input
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => void saveContainerTitle()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveContainerTitle()
                }
                if (event.key === 'Escape') {
                  setEditingTitle(false)
                  setTitleDraft(container.name)
                }
              }}
              className="field-input page-title-input"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="title-button page-title"
              onClick={() => {
                setEditingTitle(true)
                setTitleDraft(container.name)
              }}
            >
              {container.name}
            </button>
          )}
        </div>
        <div className="header-actions">
          <button type="button" className="btn btn-secondary" onClick={downloadJson}>
            下载 JSON
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setView('import')}>
            导入链接或文本
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title-row">
              <h2 className="panel-title">对话列表</h2>
              <span className="badge">{stats.conversationCount}</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button danger-button"
            onClick={() => void clearImportedHistory()}
            disabled={stats.conversationCount === 0}
          >
            清空
          </button>
        </div>

        {importHistory.length === 0 ? (
          <div className="empty-state">
            <h3>还没有导入记录</h3>
            <p>点右上角“导入链接或文本”，解析成功后会自动进入这个 Dashboard。</p>
          </div>
        ) : (
          <div className="dashboard-list">
            {importHistory.map((item) => (
              <article key={item.id} className="dashboard-item">
                <div className="dashboard-item-topline">
                  <div>
                    <h3 className="dashboard-item-title">{getDisplayConversationTitle(item)}</h3>
                    <p className="dashboard-item-meta">
                      {PLATFORM_LABEL[item.source.platform]} · {item.stats.messageCount} 条消息 · {formatTimestamp(item.source.importedAt)}
                    </p>
                    {item.source.url ? (
                      <a
                        className="dashboard-item-link"
                        href={item.source.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.source.url}
                      </a>
                    ) : null}
                  </div>
                  <span className="badge badge-primary">{PLATFORM_LABEL[item.source.platform]}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title-row">
              <h2 className="panel-title">运行日志</h2>
              <span className="badge">{runLogs.length}</span>
            </div>
            <p className="panel-meta">这里记录抓取、导入和失败信息，方便你确认当前容器发生过什么。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => void clearRunLogs()}
            disabled={runLogs.length === 0}
          >
            清除
          </button>
        </div>

        {runLogs.length === 0 ? (
          <div className="empty-state">
            <h3>还没有运行日志</h3>
            <p>你第一次开始抓取页面或导入链接之后，这里会自动出现日志。</p>
          </div>
        ) : (
          <div className="log-console">
            {runLogs.map((log) => (
              <div key={log.id} className={`log-line log-${log.level}`}>
                <span className="log-time">{formatTimestamp(log.timestamp)}</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
