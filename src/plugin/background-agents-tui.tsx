/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, onMount } from "solid-js"
import { getDelegationSnapshot, type DelegationSnapshotItem, type DelegationStatus } from "./background-agents"

const id = "external:delegation-sidebar"

const delegationRefreshMs = 2_000
const elapsedRefreshMs = 1_000
const delegationSnapshotLimit = 8
const maxDelegationLabelLength = 58
const maxDelegationIdLength = 18
const maxDelegationTitleLength = 24
const maxDelegationAgentLength = 12

function isDelegationActive(status: DelegationStatus): boolean {
  return status === "registered" || status === "running"
}

function statusGlyph(status: DelegationStatus): string {
  if (status === "registered") return "○"
  if (status === "running") return "●"
  if (status === "complete") return "✓"
  if (status === "timeout") return "⏱"
  if (status === "cancelled") return "×"
  return "!"
}

function formatElapsedTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "0s"

  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

function getDelegationElapsedMs(delegation: DelegationSnapshotItem, now: number): number {
  if (isDelegationActive(delegation.status)) {
    return now - delegation.startedAtMs
  }

  const completedAtMs = delegation.completedAtMs ?? delegation.updatedAtMs
  return completedAtMs - delegation.startedAtMs
}

function normalizeSidebarText(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function truncateSidebarText(value: string, maxLength: number): string {
  const normalizedValue = normalizeSidebarText(value)
  if (normalizedValue.length <= maxLength) return normalizedValue
  if (maxLength <= 1) return normalizedValue.slice(0, maxLength)
  return `${normalizedValue.slice(0, maxLength - 1)}…`
}

function formatDelegationLabel(delegation: DelegationSnapshotItem): string {
  const idLabel = truncateSidebarText(delegation.id, maxDelegationIdLength)
  const titleLabel = truncateSidebarText(delegation.title, maxDelegationTitleLength)
  const title = delegation.title === delegation.id ? idLabel : `${idLabel} · ${titleLabel}`
  const agent = delegation.agent ? ` (${truncateSidebarText(delegation.agent, maxDelegationAgentLength)})` : ""
  const unread = delegation.unread ? " *" : ""
  return truncateSidebarText(`${statusGlyph(delegation.status)} ${title}${agent}${unread}`, maxDelegationLabelLength)
}

function Delegations(props: { session_id: string; api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const [now, setNow] = createSignal(Date.now())
  const [isAvailable, setIsAvailable] = createSignal(true)
  const [refreshError, setRefreshError] = createSignal<string | undefined>()
  const [delegations, setDelegations] = createSignal<DelegationSnapshotItem[]>([])

  onMount(() => {
    let isDisposed = false
    let isRefreshing = false
    let latestRefreshRequest = 0

    const safeRefresh = async () => {
      if (isRefreshing) return

      isRefreshing = true
      const refreshRequest = latestRefreshRequest + 1
      latestRefreshRequest = refreshRequest

      try {
        const snapshot = await getDelegationSnapshot(props.session_id, {
          directory: props.api.state.path.directory,
          limit: delegationSnapshotLimit,
        })
        if (isDisposed || refreshRequest !== latestRefreshRequest) return

        if (!snapshot.available) {
          setIsAvailable(false)
          setRefreshError(undefined)
          setDelegations([])
          return
        }

        setIsAvailable(true)
        if (snapshot.error?.kind === "refresh-error") {
          setRefreshError("delegation refresh failed")
          if (snapshot.items.length > 0) setDelegations(snapshot.items)
          return
        }

        setRefreshError(undefined)
        setDelegations(snapshot.items)
      } catch {
        if (isDisposed || refreshRequest !== latestRefreshRequest) return
        setIsAvailable(true)
        setRefreshError("delegation refresh failed")
      } finally {
        if (refreshRequest === latestRefreshRequest) {
          isRefreshing = false
        }
      }
    }

    void safeRefresh()
    const elapsedTimer = setInterval(() => setNow(Date.now()), elapsedRefreshMs)
    const delegationTimer = setInterval(() => void safeRefresh(), delegationRefreshMs)

    onCleanup(() => {
      isDisposed = true
      clearInterval(elapsedTimer)
      clearInterval(delegationTimer)
    })
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Background Agents</b>
      </text>
      {!isAvailable() ? (
        <text fg={theme().textMuted}>background agents unavailable</text>
      ) : refreshError() ? (
        <text fg={theme().textMuted}>{refreshError()}</text>
      ) : delegations().length === 0 ? (
        <text fg={theme().textMuted}>No delegated tasks</text>
      ) : (
        delegations().map((delegation) => (
          <box>
            <text fg={isDelegationActive(delegation.status) ? theme().primary : theme().textMuted}>
              {formatDelegationLabel(delegation)}
            </text>
            <text fg={theme().textMuted}>
              {delegation.status} · {formatElapsedTime(getDelegationElapsedMs(delegation, now()))}
            </text>
          </box>
        ))
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <Delegations api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
