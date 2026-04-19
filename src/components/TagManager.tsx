import { useMemo, useState } from 'react'
import { db } from '../storage/db'
import { getNow } from '../lib/runtime'
import type { Container, Tag } from '../types'

interface Props {
  container: Container
  tags: Tag[]
  onContainersReload: () => void
  onTagsReload: () => void
}

export function TagManager({ container, tags, onContainersReload, onTagsReload }: Props) {
  const [tagName, setTagName] = useState('')
  const [tagCategory, setTagCategory] = useState('context')

  const selectedTags = useMemo(
    () => tags.filter((tag) => container.tagIds.includes(tag.id)),
    [container.tagIds, tags],
  )

  const addExistingTag = async (tag: Tag) => {
    if (container.tagIds.includes(tag.id)) return

    await Promise.all([
      db.containers.put({
        ...container,
        tagIds: [...container.tagIds, tag.id],
        updatedAt: getNow(),
      }),
      db.tags.put({
        ...tag,
        usageCount: tag.usageCount + 1,
      }),
    ])

    onContainersReload()
    onTagsReload()
  }

  const removeTag = async (tagId: string) => {
    await db.containers.put({
      ...container,
      tagIds: container.tagIds.filter((id) => id !== tagId),
      updatedAt: getNow(),
    })
    onContainersReload()
  }

  const createTag = async () => {
    const name = tagName.trim()
    const category = tagCategory.trim()
    if (!name || !category) return

    const existing = tags.find(
      (tag) => tag.name.toLowerCase() === name.toLowerCase() && tag.category.toLowerCase() === category.toLowerCase(),
    )

    if (existing) {
      await addExistingTag(existing)
      setTagName('')
      return
    }

    const now = getNow()
    const tag: Tag = {
      id: crypto.randomUUID(),
      name,
      category,
      usageCount: 1,
      createdAt: now,
    }

    await Promise.all([
      db.tags.put(tag),
      db.containers.put({
        ...container,
        tagIds: [...container.tagIds, tag.id],
        updatedAt: now,
      }),
    ])

    setTagName('')
    onContainersReload()
    onTagsReload()
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">容器标签</h2>
          <p className="panel-meta">标签不再限制为 task/stage/action，可以作为任意自定义分类使用。</p>
        </div>
      </div>

      {selectedTags.length > 0 ? (
        <div className="tag-row">
          {selectedTags.map((tag) => (
            <span key={tag.id} className="annotation-pill">
              <span className="badge badge-tag">
                {tag.category} · {tag.name}
              </span>
              <button type="button" className="icon-button" onClick={() => void removeTag(tag.id)}>
                移除
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="empty-inline">当前容器还没有标签。</div>
      )}

      <div className="form-grid">
        <label className="field">
          <span className="field-label">新标签类别</span>
          <input
            className="field-input"
            value={tagCategory}
            onChange={(event) => setTagCategory(event.target.value)}
            placeholder="例如：domain、source、priority"
          />
        </label>
        <label className="field">
          <span className="field-label">新标签名称</span>
          <div className="inline-form">
            <input
              className="field-input"
              value={tagName}
              onChange={(event) => setTagName(event.target.value)}
              placeholder="例如：登录流程"
            />
            <button type="button" className="btn btn-secondary" onClick={() => void createTag()}>
              添加
            </button>
          </div>
        </label>
      </div>

      {tags.length > 0 ? (
        <div className="section-stack">
          <h3 className="subsection-title">常用标签</h3>
          <div className="tag-row">
            {tags.slice(0, 12).map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={`badge ${container.tagIds.includes(tag.id) ? 'badge-primary' : 'badge-tag'}`}
                onClick={() =>
                  container.tagIds.includes(tag.id) ? void removeTag(tag.id) : void addExistingTag(tag)
                }
              >
                {tag.category} · {tag.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
