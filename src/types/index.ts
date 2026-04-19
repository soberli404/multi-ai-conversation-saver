export type Platform = 'chatgpt' | 'gemini' | 'claude' | 'manus' | 'web' | 'text'
export type MessageRole = 'user' | 'assistant'
export type RunLogLevel = 'info' | 'success' | 'warning' | 'error'

export interface Tag {
  id: string
  name: string
  category: string
  usageCount: number
  createdAt: number
}

export interface ImportedMessage {
  id: string
  index: number
  role: MessageRole
  content: string
  summary: string
  timestamp: string
}

export interface ImportedTurn {
  id: string
  index: number
  user?: ImportedMessage
  assistant?: ImportedMessage
}

export interface ConversationStats {
  messageCount: number
  userCount: number
  assistantCount: number
}

export interface ImportedConversationSection {
  id: string
  index: number
  title: string
  importedAt: string
  turns: ImportedTurn[]
  stats: ConversationStats
}

export interface ImportedConversation {
  id: string
  schemaVersion: '1.0' | '2.0' | '2.1'
  title: string
  customTitle?: string
  source: {
    platform: Platform
    url?: string
    title?: string
    importedAt: string
  }
  turns: ImportedTurn[]
  sections?: ImportedConversationSection[]
  stats: ConversationStats
  conversation?: {
    title: string
    messages: ImportedMessage[]
  }
}

export interface RunLogEntry {
  id: string
  level: RunLogLevel
  message: string
  timestamp: string
}

export interface ContainerAutoRefresh {
  enabled: boolean
  intervalMinutes: number
  nextRunAt?: string
  lastCheckedAt?: string
  lastUpdatedAt?: string
}

export interface Container {
  id: string
  name: string
  platform: Platform
  sourceUrl?: string
  importedConversation?: ImportedConversation
  importHistory?: ImportedConversation[]
  runLogs?: RunLogEntry[]
  autoRefresh?: ContainerAutoRefresh
  tagIds: string[]
  createdAt: number
  updatedAt: number
}

export interface ConversationMessage {
  id: string
  containerId: string
  index: number
  role: MessageRole
  content: string
  summary: string
  timestamp: string
  createdAt: number
  updatedAt: number
}

export interface MessageDraft {
  id: string
  role: MessageRole
  content: string
  summary: string
  timestamp: string
  selected: boolean
}

export interface ImportResult {
  platform: Platform
  sourceUrl?: string
  messages: MessageDraft[]
}
