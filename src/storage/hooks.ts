import { useCallback, useEffect, useState } from 'react'
import type { Container, ConversationMessage, Tag } from '../types'
import { db } from './db'

export function useContainers() {
  const [containers, setContainers] = useState<Container[]>([])

  const reload = useCallback(async () => {
    const all = await db.containers.getAll()
    setContainers(all.sort((a, b) => b.updatedAt - a.updatedAt))
  }, [])

  useEffect(() => {
    let cancelled = false

    void db.containers.getAll().then((all) => {
      if (cancelled) return
      setContainers(all.sort((a, b) => b.updatedAt - a.updatedAt))
    })

    return () => {
      cancelled = true
    }
  }, [reload])

  return { containers, reload }
}

export function useTags() {
  const [tags, setTags] = useState<Tag[]>([])

  const reload = useCallback(async () => {
    const all = await db.tags.getAll()
    setTags(all.sort((a, b) => b.usageCount - a.usageCount || b.createdAt - a.createdAt))
  }, [])

  useEffect(() => {
    let cancelled = false

    void db.tags.getAll().then((all) => {
      if (cancelled) return
      setTags(all.sort((a, b) => b.usageCount - a.usageCount || b.createdAt - a.createdAt))
    })

    return () => {
      cancelled = true
    }
  }, [reload])

  return { tags, reload }
}

export function useMessages(containerId: string) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])

  const reload = useCallback(async () => {
    const all = await db.messages.getByContainer(containerId)
    setMessages(all.sort((a, b) => a.index - b.index))
  }, [containerId])

  useEffect(() => {
    let cancelled = false

    void db.messages.getByContainer(containerId).then((all) => {
      if (cancelled) return
      setMessages(all.sort((a, b) => a.index - b.index))
    })

    return () => {
      cancelled = true
    }
  }, [containerId])

  return { messages, reload }
}
