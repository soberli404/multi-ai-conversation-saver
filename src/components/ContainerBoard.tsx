import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import { db } from '../storage/db'
import { getNow } from '../lib/runtime'
import { cleanConversationSourceTitle } from '../lib/conversation'
import type { Container, Platform, Tag } from '../types'

const PLATFORM_LABEL: Record<Platform, string> = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  manus: 'Manus',
  web: '网页',
  text: '文本',
}

const EMPTY_LABEL = '未添加'

function looksLikeSummaryTitle(value?: string) {
  if (!value) return false
  const normalized = value.trim()
  return normalized.length > 24 || normalized.includes('...') || /[，,。；;：:]/.test(normalized)
}

interface Props {
  containers: Container[]
  tags: Tag[]
  onSelect: (containerId: string) => void
  onReload: () => void
}

function getLatestImport(container: Container) {
  if (container.importHistory?.length) {
    return container.importHistory.at(-1)
  }

  return container.importedConversation
}

function getDisplayPlatform(container: Container): Platform {
  return getLatestImport(container)?.source.platform ?? container.platform
}

function getDisplaySourceUrl(container: Container) {
  return getLatestImport(container)?.source.url ?? container.sourceUrl
}

function getDisplayPlatformLabel(container: Container) {
  if (getConversationCount(container) === 0) return EMPTY_LABEL
  return PLATFORM_LABEL[getDisplayPlatform(container)]
}

function getConversationCount(container: Container) {
  return container.importHistory?.length ?? (container.importedConversation ? 1 : 0)
}

function getMessageCount(container: Container) {
  if (container.importHistory?.length) {
    return container.importHistory.reduce((sum, item) => sum + item.stats.messageCount, 0)
  }
  return container.importedConversation?.stats.messageCount ?? 0
}

export function ContainerBoard({ containers, tags, onSelect, onReload }: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const tagMap = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])

  useEffect(() => {
    let cancelled = false

    const repairFirstBrokenTitle = async () => {
      const target = containers
        .flatMap((container) =>
          (container.importHistory ?? []).map((conversation) => ({
            container,
            conversation,
          })),
        )
        .find(({ conversation }) =>
          Boolean(conversation.source.url)
          && !conversation.source.title
          && looksLikeSummaryTitle(conversation.title),
        )

      if (!target?.conversation.source.url) return

      const response = await new Promise<{ sourceTitle?: string; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_SOURCE_TITLE', url: target.conversation.source.url },
          (result: { sourceTitle?: string; error?: string } | undefined) => {
            resolve(result ?? {})
          },
        )
      })

      if (cancelled || response.error) return

      const repairedTitle = cleanConversationSourceTitle(response.sourceTitle)
      if (!repairedTitle || repairedTitle === target.conversation.title) return

      const nextHistory = (target.container.importHistory ?? []).map((conversation) =>
        conversation.id === target.conversation.id
          ? {
              ...conversation,
              title: repairedTitle,
              source: {
                ...conversation.source,
                title: repairedTitle,
              },
            }
          : conversation,
      )

      await db.containers.put({
        ...target.container,
        importHistory: nextHistory,
        importedConversation:
          target.container.importedConversation?.id === target.conversation.id
            ? {
                ...target.container.importedConversation,
                title: repairedTitle,
                source: {
                  ...target.container.importedConversation.source,
                  title: repairedTitle,
                },
              }
            : target.container.importedConversation,
        updatedAt: getNow(),
      })

      if (!cancelled) {
        onReload()
      }
    }

    void repairFirstBrokenTitle()

    return () => {
      cancelled = true
    }
  }, [containers, onReload])

  const addContainer = async () => {
    const name = newName.trim()
    if (!name) return

    const now = getNow()
    const container: Container = {
      id: crypto.randomUUID(),
      name,
      platform: 'text',
      importHistory: [],
      runLogs: [],
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    }

    await db.containers.put(container)
    setNewName('')
    setShowCreate(false)
    onReload()
  }

  const removeContainer = async (container: Container, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    await Promise.all([
      db.messages.deleteByContainer(container.id),
      db.containers.del(container.id),
    ])
    onReload()
  }

  const startRename = (container: Container, event: MouseEvent<HTMLElement>) => {
    event.stopPropagation()
    setEditingId(container.id)
    setEditingName(container.name)
  }

  const saveRename = async (container: Container) => {
    const name = editingName.trim()
    if (!name || name === container.name) {
      setEditingId(null)
      setEditingName('')
      return
    }

    await db.containers.put({
      ...container,
      name,
      updatedAt: getNow(),
    })

    setEditingId(null)
    setEditingName('')
    onReload()
  }

  const stats = {
    containers: containers.length,
    totalImports: containers.reduce((sum, container) => sum + getConversationCount(container), 0),
  }

  return (
    <div className="board-shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">对话资产归档</p>
          <h1 className="page-title">多 AI 对话保存器</h1>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? '收起新建' : '新建容器'}
        </button>
      </header>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">容器数</span>
          <strong className="stat-value">{stats.containers}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">总共导入次数</span>
          <strong className="stat-value">{stats.totalImports}</strong>
        </article>
      </section>

      {showCreate ? (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">创建容器</h2>
              <p className="panel-meta">给每个对话或素材组一个名字，后续在详情里导入链接或文本。</p>
            </div>
          </div>
          <div className="inline-form">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className="field-input"
              placeholder="例如：客户需求整理"
              onKeyDown={(event) => event.key === 'Enter' && void addContainer()}
            />
            <button type="button" className="btn btn-primary" onClick={() => void addContainer()}>
              保存容器
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">容器列表</h2>
            <p className="panel-meta">点击容器进入详情页，查看对话列表、运行日志并继续导入链接。</p>
          </div>
        </div>

        {containers.length === 0 ? (
          <div className="empty-state">
            <h3>还没有容器</h3>
            <p>先创建一个容器，再把对话链接放进去自动保存。</p>
          </div>
        ) : (
          <div className="card-stack">
            {containers.map((container) => {
              const selectedTags = container.tagIds
                .map((tagId) => tagMap.get(tagId))
                .filter((tag): tag is Tag => Boolean(tag))
              const displaySourceUrl = getDisplaySourceUrl(container)
              const displayPlatformLabel = getDisplayPlatformLabel(container)
              const isEmpty = getConversationCount(container) === 0

              return (
                <article
                  key={container.id}
                  className="container-card"
                  onClick={() => onSelect(container.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(container.id)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="card-topline">
                    <div>
                      <span className="badge badge-platform">{displayPlatformLabel}</span>
                      {editingId === container.id ? (
                        <input
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => void saveRename(container)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void saveRename(container)
                            }
                            if (event.key === 'Escape') {
                              setEditingId(null)
                              setEditingName('')
                            }
                          }}
                          className="field-input title-input"
                          autoFocus
                        />
                      ) : (
                        <button type="button" className="title-button container-title" onClick={(event) => startRename(container, event)}>
                          {container.name}
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={(event) => void removeContainer(container, event)}
                      aria-label={`删除 ${container.name}`}
                    >
                      删除
                    </button>
                  </div>
                  <p className="container-meta">
                    {getConversationCount(container) > 0
                      ? `已导入 ${getConversationCount(container)} 组对话，累计 ${getMessageCount(container)} 条消息`
                      : EMPTY_LABEL}
                  </p>
                  {!isEmpty && displaySourceUrl ? <p className="supporting-text">{displaySourceUrl}</p> : null}
                  {selectedTags.length > 0 ? (
                    <div className="tag-row">
                      {selectedTags.map((tag) => (
                        <span key={tag.id} className="badge badge-tag">
                          {tag.category} · {tag.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
