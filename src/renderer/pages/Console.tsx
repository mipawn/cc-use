import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Alert, Button, Input, Popconfirm, Space, Switch, Tabs, Tag, Tooltip, theme } from 'antd'
import {
  ClearOutlined,
  CopyOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ConsoleEvent, ConsoleLogEvent, ConsoleRequestEvent } from '@shared/types'
import {
  CONSOLE_BUFFER_LIMIT,
  clearConsoleHistory,
  getConsoleEvents,
  getConsoleHistoryMeta,
  hydrateConsoleHistory,
  pruneExpiredConsoleEvents,
  subscribeConsoleStore,
} from '../api/consoleStore'
import type { ConsoleHistoryMeta } from '../api/consoleStore'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { getApi } from '../api'
import styles from './Console.module.css'

/**
 * Control-room terminal.
 *
 * One page, one stream, three tabs: requests, problem requests and the
 * persisted runtime log. The log is the on-disk console history, not a
 * separate screen, so there is no second observation page to keep in sync.
 *
 * Pure projection/filter helpers stay exported for `consoleFilters.test.ts`.
 * They never touch the DOM at module scope.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string

export type ConsoleView = 'requests' | 'problems' | 'logs'

export type RequestResultKind =
  | 'ok'
  | 'estimated'
  | 'rejected'
  | 'cancelled'
  | 'upstream_error'
  | 'ws'
  | 'pending'
  | 'unknown'

export type RequestHttpClass = 'success' | '4xx' | '5xx' | 'none' | 'other'

export interface RequestProjection {
  key: string
  event: ConsoleRequestEvent
  /** Normalised result shown to the user (historical ok+4xx becomes a failure). */
  result: RequestResultKind
  /** Rejected / cancelled / upstream_error / HTTP >= 400. */
  exceptional: boolean
  /** Reached a terminal, non-WS state. Pending and WS upgrades are not complete. */
  completed: boolean
  /** Completed without a failure. Pending/WS are never "success". */
  success: boolean
  httpClass: RequestHttpClass
  timeLabel: string
  dateTimeLabel: string
}

export interface LogProjection {
  key: string
  event: ConsoleLogEvent
  timeLabel: string
  dateTimeLabel: string
  /** Normalised level group (trace folds into debug). */
  levelGroup: 'error' | 'warn' | 'info' | 'debug' | null
}

/** Old on-disk rows are UTC `YYYY-MM-DD HH:MM:SS`, never local naive strings. */
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** Never let a long-open page claim to show more than the retention window. */
const AGE_RECHECK_INTERVAL_MS = 25_000

function parseUtcTimestamp(ts: string): Date | null {
  const match = ts.match(UTC_TIMESTAMP_PATTERN)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  )
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Render a stored UTC timestamp as local wall-clock time. */
export function formatLocalTime(ts: string): string {
  const date = parseUtcTimestamp(ts)
  if (!date) {
    const index = ts.indexOf(' ')
    return index === -1 ? ts : ts.slice(index + 1)
  }
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Full local timestamp for the detail panel. */
export function formatLocalDateTime(ts: string): string {
  const date = parseUtcTimestamp(ts)
  if (!date) return ts
  const localDate = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return `${localDate} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** Kind labels live in the locale files like every other user-facing string. */
function kindLabel(kind: string, t: (key: string) => string): string {
  const key = `console.kinds.${kind}`
  const translated = t(key)
  return translated === key ? kind : translated
}

function levelGroup(level: string): LogProjection['levelGroup'] {
  const lower = level.toLowerCase()
  if (lower === 'error' || lower === 'warn' || lower === 'info') return lower
  if (lower === 'debug' || lower === 'trace') return 'debug'
  return null
}

function formatLatency(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

const anonymousRowKeys = new WeakMap<ConsoleEvent, string>()
const rowKeyEpoch = Date.now().toString(36)
let anonymousRowSequence = 0

/** Row identity must survive older rows being evicted from the bounded buffer. */
export function eventRowKey(event: ConsoleEvent): string {
  const persistedId = event.category === 'request' ? event.requestId : event.id
  if (persistedId) return persistedId
  let key = anonymousRowKeys.get(event)
  if (!key) {
    const source = event.category === 'log' ? event.source : 'request'
    key = `${source}:anonymous:${rowKeyEpoch}:${++anonymousRowSequence}`
    anonymousRowKeys.set(event, key)
  }
  return key
}

function classifyHttpStatus(status: number | null | undefined): RequestHttpClass {
  if (status == null) return 'none'
  if (status >= 200 && status < 400) return 'success'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500 && status < 600) return '5xx'
  return 'other'
}

/**
 * The single classification function. Historical rows were always stored as
 * `ok` even for 4xx/5xx responses, so the status code wins there; pending and
 * websocket upgrades are deliberately not turned into completed successes.
 */
export function classifyRequestResult(event: ConsoleRequestEvent): RequestResultKind {
  const failedStatus = event.status != null && event.status >= 400
  switch (event.kind) {
    case 'ok':
      return failedStatus ? 'upstream_error' : 'ok'
    case 'estimated':
      return failedStatus ? 'upstream_error' : 'estimated'
    case 'upstream_error':
    case 'rejected':
    case 'cancelled':
    case 'ws':
    case 'pending':
      return event.kind
    default:
      return failedStatus ? 'upstream_error' : 'unknown'
  }
}

export function projectRequestEvent(event: ConsoleRequestEvent): RequestProjection {
  const result = classifyRequestResult(event)
  const exceptional = result === 'upstream_error' || result === 'rejected' || result === 'cancelled'
  const completed = result !== 'pending' && result !== 'ws'
  return {
    key: eventRowKey(event),
    event,
    result,
    exceptional,
    completed,
    success: completed && !exceptional && (result === 'ok' || result === 'estimated'),
    httpClass: classifyHttpStatus(event.status),
    timeLabel: formatLocalTime(event.timestamp),
    dateTimeLabel: formatLocalDateTime(event.timestamp),
  }
}

export function projectLogEvent(event: ConsoleLogEvent): LogProjection {
  return {
    key: eventRowKey(event),
    event,
    timeLabel: formatLocalTime(event.timestamp),
    dateTimeLabel: formatLocalDateTime(event.timestamp),
    levelGroup: levelGroup(event.level),
  }
}

/** `Provider / Key`, or a dash when neither is known. */
function routeLabel(event: ConsoleRequestEvent): string {
  const parts = [event.provider, event.keyAlias].filter((value) => value && value.trim())
  return parts.length > 0 ? parts.join(' / ') : '—'
}

/** The short line a user scans: status text, or the path when there is none. */
function requestSummary(event: ConsoleRequestEvent): string {
  if (event.message) return event.message
  if (event.path) return event.path
  return ''
}

/** Keyword search over the fields a user can see in a row (never the body). */
export function matchesQuery(event: ConsoleEvent, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  if (event.category === 'request') {
    return [
      event.requestId,
      event.model,
      event.provider,
      event.keyAlias,
      event.path,
      event.upstream,
      event.message,
      event.kind,
      event.status != null ? String(event.status) : null,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  }
  return [event.message, event.target, event.source, event.level]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle))
}

export interface ClearOutcome {
  /** False when the runtime answered with the legacy empty payload. */
  confirmed: boolean
  ok: boolean
  app: boolean
  daemon: boolean
}

/** Per-owner clear result. Older runtimes return nothing, hence the guard. */
export function parseClearResult(raw: unknown): ClearOutcome | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.ok !== 'boolean') return null
  if (typeof value.app !== 'boolean' || typeof value.daemon !== 'boolean') return null
  return { confirmed: true, ok: value.ok, app: value.app, daemon: value.daemon }
}

function clearOutcomeMessage(outcome: ClearOutcome, tr: Translate): string {
  if (!outcome.confirmed) return tr('console.clearUnconfirmed')
  if (outcome.ok) return tr('console.clearSuccess')
  if (!outcome.app && !outcome.daemon) return tr('console.clearFailed')
  const failed = [
    !outcome.app ? tr('console.ownerApp') : null,
    !outcome.daemon ? tr('console.ownerDaemon') : null,
  ]
    .filter(Boolean)
    .join(' / ')
  return tr('console.clearPartial', { failed })
}

function clearOutcomeType(outcome: ClearOutcome): 'success' | 'warning' | 'error' | 'info' {
  if (!outcome.confirmed) return 'info'
  if (outcome.ok) return 'success'
  if (!outcome.app && !outcome.daemon) return 'error'
  return 'warning'
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value)
}

function sameHistoryMeta(a: ConsoleHistoryMeta | null, b: ConsoleHistoryMeta | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.truncated === b.truncated &&
    a.error === b.error &&
    a.generation === b.generation &&
    a.retention?.retentionStartDate === b.retention?.retentionStartDate
  )
}

/** Token colors, so the terminal is light on a light theme and dark on dark. */
function useTerminalPalette() {
  const { token } = theme.useToken()
  return {
    background: token.colorBgContainer,
    border: token.colorBorderSecondary,
    text: token.colorText,
    dim: token.colorTextTertiary,
    accent: token.colorPrimary,
    ok: token.colorSuccess,
    warn: token.colorWarning,
    error: token.colorError,
    info: token.colorInfo,
    selected: token.colorPrimaryBg,
  }
}

type TerminalPalette = ReturnType<typeof useTerminalPalette>

function resultColor(projection: RequestProjection, palette: TerminalPalette): string {
  if (projection.exceptional) return palette.error
  if (projection.success) return palette.ok
  if (projection.result === 'ws') return palette.info
  if (projection.result === 'pending') return palette.warn
  return palette.dim
}

function logColor(projection: LogProjection, palette: TerminalPalette): string {
  switch (projection.levelGroup) {
    case 'error':
      return palette.error
    case 'warn':
      return palette.warn
    case 'debug':
      return palette.dim
    default:
      return palette.ok
  }
}

/** One request: time, result, model, route, latency and a short summary. */
function RequestRow({
  projection,
  selected,
  palette,
  onSelect,
}: {
  projection: RequestProjection
  selected: boolean
  palette: TerminalPalette
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const event = projection.event
  return (
    <div
      data-testid='console-request-row'
      role='button'
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(keyboardEvent) => {
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault()
          onSelect()
        }
      }}
      className={styles.requestRow}
      style={{
        background: selected ? palette.selected : undefined,
        borderLeftColor: projection.exceptional ? palette.error : 'transparent',
      }}
    >
      <span style={{ color: palette.dim, flexShrink: 0 }}>{projection.timeLabel}</span>
      <span
        className={styles.ellipsis}
        title={`${kindLabel(projection.result, t)}${event.status != null ? ` ${event.status}` : ''}`}
        style={{
          color: resultColor(projection, palette),
          flexShrink: 0,
          width: 120,
          whiteSpace: 'nowrap',
        }}
      >
        {kindLabel(projection.result, t)}
        {event.status != null ? ` ${event.status}` : ''}
      </span>
      <span className={styles.modelCell} style={{ flexShrink: 0, width: 190 }}>
        <span className={styles.ellipsis}>{event.model || '—'}</span>
        {event.requestKind === 'auto_mode' && (
          <Tag color='gold' style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '15px' }}>
            Auto
          </Tag>
        )}
      </span>
      <span
        style={{
          color: palette.accent,
          flexShrink: 0,
          width: 150,
        }}
        className={styles.ellipsis}
      >
        {routeLabel(event)}
      </span>
      <span style={{ color: palette.dim, flexShrink: 0, width: 60, textAlign: 'right' }}>
        {formatLatency(event.latencyMs)}
      </span>
      <span style={{ color: palette.text, flex: 1, minWidth: 120 }} className={styles.ellipsis}>
        {requestSummary(event)}
      </span>
    </div>
  )
}

/** One log record: plain terminal line, no second detail layer. */
function LogRow({ projection, palette }: { projection: LogProjection; palette: TerminalPalette }) {
  const event = projection.event
  const origin = event.target ? `${event.source}/${event.target}` : event.source
  return (
    <div data-testid='console-log-row' className={styles.logRow}>
      <span style={{ color: palette.dim }}>{`[${projection.timeLabel}] `}</span>
      <span style={{ color: logColor(projection, palette), fontWeight: 600 }}>
        {event.level.toUpperCase().padEnd(5)}
      </span>
      <span> </span>
      <span style={{ color: palette.accent }}>{origin}</span>
      <span style={{ color: palette.dim }}>{': '}</span>
      <span style={{ color: palette.text }}>{event.message}</span>
    </div>
  )
}

/** A request's full record on demand; logs stay a single terminal line. */
function RequestDetail({
  projection,
  palette,
  onClose,
}: {
  projection: RequestProjection
  palette: TerminalPalette
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('summary')
  const event = projection.event
  const requestId = event.requestId

  useEffect(() => {
    setTab('summary')
  }, [event.requestId, event.requestKind])

  const hasDetail = Boolean(
    event.requestHeaders?.length ||
    event.requestBody ||
    event.responseHeaders?.length ||
    event.responseBody,
  )

  return (
    <div
      className={styles.detailPanel}
      style={{ background: palette.background, borderColor: palette.border, color: palette.text }}
    >
      <Space className='justify-between w-full'>
        <Space size={6} wrap>
          <Tag
            color={
              projection.exceptional
                ? 'red'
                : projection.result === 'ok' || projection.result === 'estimated'
                  ? 'green'
                  : 'default'
            }
          >
            {kindLabel(projection.result, t)}
          </Tag>
          <span>{event.model || '—'}</span>
          {event.requestKind === 'auto_mode' && <Tag color='gold'>Auto</Tag>}
          <span style={{ color: palette.dim, fontSize: 12 }}>{formatLatency(event.latencyMs)}</span>
        </Space>
        <Button
          type='text'
          size='small'
          aria-label={t('common.close')}
          onClick={onClose}
          style={{ color: palette.dim }}
        >
          ✕
        </Button>
      </Space>

      <Space size={4} wrap>
        <span style={{ color: palette.accent, fontSize: 12 }}>{routeLabel(event)}</span>
        {requestId && (
          <Tooltip title={t('console.copyRequestId')}>
            <Button
              type='text'
              size='small'
              aria-label={t('console.copyRequestId')}
              icon={<CopyOutlined />}
              onClick={() => copyText(requestId)}
              style={{ color: palette.dim }}
            />
          </Tooltip>
        )}
      </Space>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        size='small'
        items={[
          {
            key: 'summary',
            label: t('console.summary'),
            children: (
              <Space orientation='vertical' size={6} style={{ fontSize: 12 }}>
                <div style={{ color: palette.dim }}>{projection.dateTimeLabel}</div>
                <div style={{ color: palette.dim }}>{t('console.upstream')}</div>
                <div style={{ wordBreak: 'break-all' }}>{event.upstream || event.path}</div>
                {event.status != null && (
                  <div style={{ color: palette.dim }}>
                    {t('console.httpStatus', { status: event.status })}
                  </div>
                )}
                {event.message && <div style={{ color: palette.warn }}>{event.message}</div>}
                {projection.result === 'ws' && (
                  <div style={{ color: palette.info }}>{t('console.wsUpgraded')}</div>
                )}
                {projection.result === 'pending' && (
                  <div style={{ color: palette.warn }}>{t('console.pendingHint')}</div>
                )}
              </Space>
            ),
          },
          {
            key: 'request',
            label: t('console.reqHeaders'),
            children: hasDetail ? (
              <DetailSection
                label={t('console.reqHeaders')}
                headers={event.requestHeaders}
                body={event.requestBody}
                palette={palette}
              />
            ) : (
              <span style={{ color: palette.dim, fontSize: 12 }}>
                {t('console.detailNotCaptured')}
              </span>
            ),
          },
          {
            key: 'response',
            label: t('console.respHeaders'),
            children: hasDetail ? (
              <DetailSection
                label={t('console.respHeaders')}
                headers={event.responseHeaders}
                body={event.responseBody}
                palette={palette}
              />
            ) : (
              <span style={{ color: palette.dim, fontSize: 12 }}>
                {t('console.detailNotCaptured')}
              </span>
            ),
          },
        ]}
      />
    </div>
  )
}

function DetailSection({
  label,
  headers,
  body,
  palette,
}: {
  label: string
  headers?: string[] | null
  body?: string | null
  palette: TerminalPalette
}) {
  const { t } = useTranslation()
  const copyable = [headers?.join('\n'), body].filter(Boolean).join('\n\n')
  return (
    <div>
      <Space className='justify-between w-full' size={4}>
        <div style={{ color: palette.accent, fontSize: 11 }}>{label}</div>
        {copyable && (
          <Tooltip title={t('console.copyBody')}>
            <Button
              type='text'
              size='small'
              aria-label={t('console.copyBody')}
              icon={<CopyOutlined />}
              onClick={() => copyText(copyable)}
              style={{ color: palette.dim }}
            />
          </Tooltip>
        )}
      </Space>
      {headers?.length ? (
        <div style={{ color: palette.dim, fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 2 }}>
          {headers.map((header, index) => (
            <div key={index}>{header}</div>
          ))}
        </div>
      ) : null}
      {body ? (
        <pre
          style={{
            color: palette.text,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginTop: 4,
            marginBottom: 0,
          }}
        >
          {body}
        </pre>
      ) : null}
    </div>
  )
}

export default function Console() {
  const { t } = useTranslation()
  const tr = t as unknown as Translate
  const palette = useTerminalPalette()
  const events = useSyncExternalStore(subscribeConsoleStore, getConsoleEvents)
  const [view, setView] = useState<ConsoleView>('requests')
  const [query, setQuery] = useState('')
  const [detailMode, setDetailMode] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [newCount, setNewCount] = useState(0)
  const [following, setFollowing] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearOutcome, setClearOutcome] = useState<ClearOutcome | null>(null)
  const [historyMeta, setHistoryMeta] = useState<ConsoleHistoryMeta | null>(null)

  // The store owns the canonical 3-local-day prune and mutates its own buffer;
  // this page only schedules the recheck (<=30 s) and the immediate check on
  // visibility/focus restore, and never claims the list is complete.
  useEffect(() => {
    const check = () => {
      pruneExpiredConsoleEvents()
    }
    check()
    const timer = window.setInterval(check, AGE_RECHECK_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') check()
    }
    const onFocus = () => check()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const requestRows = useMemo(() => {
    const rows: RequestProjection[] = []
    events.forEach((event) => {
      if (event.category === 'request') rows.push(projectRequestEvent(event))
    })
    return rows
  }, [events])

  const logRows = useMemo(() => {
    const rows: LogProjection[] = []
    events.forEach((event) => {
      if (event.category === 'log') rows.push(projectLogEvent(event))
    })
    return rows
  }, [events])

  const visibleRequests = useMemo(
    () => requestRows.filter((row) => matchesQuery(row.event, query)),
    [requestRows, query],
  )
  const visibleProblems = useMemo(
    () => visibleRequests.filter((row) => row.exceptional),
    [visibleRequests],
  )
  const visibleLogs = useMemo(
    () => logRows.filter((row) => matchesQuery(row.event, query)),
    [logRows, query],
  )
  const activeRows =
    view === 'logs' ? visibleLogs : view === 'problems' ? visibleProblems : visibleRequests
  const visibleKeys = useMemo(() => activeRows.map((row) => row.key), [activeRows])

  const toggleSelected = useCallback((key: string) => {
    setSelectedKey((previous) => (previous === key ? null : key))
  }, [])

  const selectedRequest = useMemo(() => {
    if (view === 'logs' || !selectedKey) return null
    return requestRows.find((row) => row.key === selectedKey) ?? null
  }, [view, selectedKey, requestRows])

  useEffect(() => {
    setSelectedKey(null)
    setNewCount(0)
    setFollowing(true)
    stickBottomRef.current = true
    manuallyPausedRef.current = false
  }, [view, query])

  const syncDetailMode = useCallback(async () => {
    try {
      setDetailMode(await getApi().proxy.getDetailMode())
    } catch {
      // The daemon may not be up yet; leave the switch as-is rather than
      // showing a state we could not confirm.
    }
  }, [])

  const handleDetailMode = (checked: boolean) => {
    setDetailMode(checked)
    getApi()
      .proxy.setDetailMode(checked)
      .catch(() => {
        setDetailMode(!checked)
      })
  }

  const syncHistoryMeta = useCallback(() => {
    const next = getConsoleHistoryMeta()
    setHistoryMeta((previous) => (sameHistoryMeta(previous, next) ? previous : next))
  }, [])

  useEffect(() => {
    syncHistoryMeta()
    return subscribeConsoleStore(syncHistoryMeta)
  }, [syncHistoryMeta])

  const refreshHistory = useCallback(async () => {
    try {
      await hydrateConsoleHistory()
    } catch (error) {
      console.error('Failed to restore console history:', error)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([refreshHistory(), syncDetailMode()])
    } finally {
      setRefreshing(false)
    }
  }, [refreshHistory, syncDetailMode])

  useEffect(() => {
    void refreshHistory()
    void syncDetailMode()
  }, [refreshHistory, syncDetailMode])

  usePageRefresh(refreshAll)

  const handleClear = useCallback(async () => {
    setClearing(true)
    setClearOutcome(null)
    try {
      const raw: unknown = await clearConsoleHistory()
      const outcome = parseClearResult(raw) ?? {
        confirmed: false,
        ok: false,
        app: false,
        daemon: false,
      }
      setClearOutcome(outcome)
      setSelectedKey(null)
      setNewCount(0)
      setFollowing(true)
      stickBottomRef.current = true
      manuallyPausedRef.current = false
    } catch (error) {
      console.error('Failed to clear console history:', error)
      setClearOutcome({ confirmed: true, ok: false, app: false, daemon: false })
    } finally {
      setClearing(false)
      syncHistoryMeta()
    }
  }, [syncHistoryMeta])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // Track whether the user is "parked" at the bottom; if they've scrolled
  // up to read history, we stop auto-scrolling so new events don't yank them.
  const stickBottomRef = useRef(true)
  const manuallyPausedRef = useRef(false)
  const knownKeysRef = useRef<Set<string>>(new Set())
  const filterIdentity = JSON.stringify([view, query])
  const knownFilterRef = useRef(filterIdentity)

  useLayoutEffect(() => {
    const added = visibleKeys.filter((key) => !knownKeysRef.current.has(key)).length
    knownKeysRef.current = new Set(visibleKeys)
    if (knownFilterRef.current !== filterIdentity) {
      knownFilterRef.current = filterIdentity
      setNewCount(0)
      if (stickBottomRef.current && scrollerRef.current) {
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
      }
      return
    }
    if (added <= 0) return
    if (stickBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
      setNewCount(0)
      return
    }
    // Following is paused; say how much arrived rather than moving the view.
    setNewCount((count) => count + added)
  }, [visibleKeys, filterIdentity])

  const onScrollerScroll = () => {
    const element = scrollerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickBottomRef.current = distance < 20 && !manuallyPausedRef.current
    setFollowing(stickBottomRef.current)
    if (stickBottomRef.current) setNewCount(0)
  }

  const jumpToLatest = () => {
    const element = scrollerRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    manuallyPausedRef.current = false
    stickBottomRef.current = true
    setFollowing(true)
    setNewCount(0)
  }

  useEffect(() => {
    if (!selectedKey) return
    const onKeyDown = (keyboardEvent: globalThis.KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') setSelectedKey(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedKey])

  const emptyState = (
    <div className={styles.empty} style={{ color: palette.dim }}>
      <span style={{ color: palette.accent }}>▸</span>{' '}
      {query ? (
        <Space size={8}>
          <span>{t('console.emptyFiltered')}</span>
          <Button size='small' type='link' onClick={() => setQuery('')}>
            {t('console.resetFilters')}
          </Button>
        </Space>
      ) : view === 'requests' ? (
        t('console.emptyHint')
      ) : view === 'problems' ? (
        t('console.noProblems')
      ) : (
        t('console.emptyLogs')
      )}
    </div>
  )

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <Tabs
          className={styles.tabs}
          size='small'
          activeKey={view}
          onChange={(key) => setView(key as ConsoleView)}
          items={[
            { key: 'requests', label: t('console.viewRequests') },
            {
              key: 'problems',
              label:
                visibleProblems.length > 0
                  ? `${t('console.viewProblems')} ${visibleProblems.length}`
                  : t('console.viewProblems'),
            },
            { key: 'logs', label: t('console.viewLogs') },
          ]}
        />
        <div className={styles.actions}>
          <Input.Search
            allowClear
            className={styles.search}
            placeholder={
              view === 'logs' ? t('console.logSearchPlaceholder') : t('console.searchPlaceholder')
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={
              view === 'logs' ? t('console.logSearchPlaceholder') : t('console.searchPlaceholder')
            }
          />
          {view !== 'logs' && (
            <Tooltip title={t('console.detailModeHint')}>
              <div className={styles.toggleField}>
                <Switch
                  size='small'
                  checked={detailMode}
                  onChange={handleDetailMode}
                  aria-label={t('console.detailMode')}
                />
                <span>{t('console.detailMode')}</span>
              </div>
            </Tooltip>
          )}
          <Button
            size='small'
            icon={following ? <PauseOutlined /> : <PlayCircleOutlined />}
            onClick={() => {
              if (!following) jumpToLatest()
              else {
                manuallyPausedRef.current = true
                stickBottomRef.current = false
                setFollowing(false)
              }
            }}
          >
            {t(following ? 'console.pause' : 'console.resume')}
          </Button>
          <Button
            type='text'
            size='small'
            icon={<ReloadOutlined />}
            loading={refreshing}
            onClick={() => void refreshAll()}
          >
            {t('common.refresh')}
          </Button>
          <Popconfirm
            title={t('console.clearConfirmTitle')}
            description={t('console.clearConfirmDesc')}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            disabled={clearing}
            onConfirm={() => void handleClear()}
          >
            <Button type='text' size='small' danger icon={<ClearOutlined />} loading={clearing}>
              {t('console.clear')}
            </Button>
          </Popconfirm>
        </div>
      </div>

      <div className={styles.streamHeader}>
        <span className={styles.bufferInfo}>
          {t('console.bufferInfo', { count: events.length, max: CONSOLE_BUFFER_LIMIT })}
        </span>
        <span className={styles.bufferHint}>{t('console.boundedWindowShort')}</span>
      </div>

      {historyMeta?.error && (
        <Alert
          type='warning'
          showIcon
          title={t('console.historyLoadFailed')}
          description={historyMeta.error}
          action={
            <Button size='small' onClick={() => void refreshHistory()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {clearOutcome && (
        <div data-testid='console-clear-result'>
          <Alert
            type={clearOutcomeType(clearOutcome)}
            showIcon
            closable={{ onClose: () => setClearOutcome(null) }}
            title={clearOutcomeMessage(clearOutcome, tr)}
          />
        </div>
      )}

      <div className={styles.terminalLayout}>
        <div className={styles.streamPane}>
          <div
            ref={scrollerRef}
            data-testid='console-scroller'
            onScroll={onScrollerScroll}
            className={styles.stream}
            style={{
              background: palette.background,
              color: palette.text,
              borderColor: palette.border,
            }}
          >
            {activeRows.length === 0
              ? emptyState
              : view === 'logs'
                ? visibleLogs.map((projection) => (
                    <LogRow key={projection.key} projection={projection} palette={palette} />
                  ))
                : (view === 'problems' ? visibleProblems : visibleRequests).map((projection) => (
                    <RequestRow
                      key={projection.key}
                      projection={projection}
                      selected={selectedKey === projection.key}
                      palette={palette}
                      onSelect={() => toggleSelected(projection.key)}
                    />
                  ))}
          </div>

          {newCount > 0 && (
            <Button size='small' type='primary' onClick={jumpToLatest} className={styles.newEvents}>
              {t('console.newEvents', { count: newCount })}
            </Button>
          )}
        </div>

        {selectedRequest && (
          <RequestDetail
            projection={selectedRequest}
            palette={palette}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
    </div>
  )
}
