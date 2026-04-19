import { useMemo, useState } from 'react'
import { ContainerBoard } from './components/ContainerBoard'
import { ContainerDetail } from './components/ContainerDetail'
import { useContainers, useTags } from './storage/hooks'

export default function App() {
  const { containers, reload: reloadContainers } = useContainers()
  const { tags } = useTags()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const current = useMemo(
    () => (selectedId ? containers.find((container) => container.id === selectedId) ?? null : null),
    [containers, selectedId],
  )

  return (
    <div className="app-shell">
      {current ? (
        <ContainerDetail
          container={current}
          tags={tags}
          onBack={() => setSelectedId(null)}
          onContainersReload={reloadContainers}
        />
      ) : (
        <ContainerBoard
          containers={containers}
          tags={tags}
          onSelect={setSelectedId}
          onReload={reloadContainers}
        />
      )}
    </div>
  )
}
