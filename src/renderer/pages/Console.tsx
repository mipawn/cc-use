import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Space, Switch, Typography, theme } from 'antd'
import { ClearOutlined, DownOutlined, RightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ConsoleEvent, ConsoleLogEvent, ConsoleRequestEvent } from '../../shared/types'
import {
  CONSOLE_BUFFER_LIMIT,
  clearConsoleEvents,
  getConsoleEvents,
  subscribeConsoleStore,
} from '../api/consoleStore'
import { getApi } from '../api'

/// Terminal palette (VS Code Dark+ inspired). Intentionally not tied to
/// AntD tokens — the console should read like a real terminal regardless
/// of the app's light/dark theme.
const PALETTE = {
  bg: '#1e1e1e',
  border: '#2d2d2d',
  dim: '#8a8a8a',
  text: '#e5e5e5',
  methodGet: '#569cd6',
  methodPost: '#4ec9b0',
  methodWs: '#c586c0',
  ok: '#4ec9b0',
  rejected: '#dcdcaa',
  upstreamError: '#f48771',
  ws: '#4fc1ff',
  note: '#ce9178',
  accent: '#9cdcfe',
  upstreamAddr: '#d7ba7d',
  prompt: '#6a9955',
  logError: '#f48771',
  logWarn: '#dcdcaa',
  logInfo: '#9cdcfe',
  logDebug: '#8a8a8a',
  sourceDaemon: '#4ec9b0',
  sourceApp: '#c586c0',
  sourceRenderer: '#569cd6',
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case 'ok':
      return '✓'
    case 'rejected':
      return '✗'
    case 'upstream_error':
      return '⚠'
    case 'ws':
      return '↔'
    case 'pending':
      return '…'
    default:
      return '·'
  }
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'ok':
      return PALETTE.ok
    case 'rejected':
      return PALETTE.rejected
    case 'upstream_error':
      return PALETTE.upstreamError
    case 'ws':
      return PALETTE.ws
    case 'pending':
      return PALETTE.dim
    default:
      return PALETTE.text
  }
}

function methodColor(method: string): string {
  if (method === 'WS') return PALETTE.methodWs
  if (method === 'GET') return PALETTE.methodGet
  return PALETTE.methodPost
}

function levelColor(level: string): string {
  switch (level) {
    case 'error':
      return PALETTE.logError
    case 'warn':
      return PALETTE.logWarn
    case 'debug':
    case 'trace':
      return PALETTE.logDebug
    default:
      return PALETTE.logInfo
  }
}

function sourceColor(source: string): string {
  switch (source) {
    case 'daemon':
      return PALETTE.sourceDaemon
    case 'app':
      return PALETTE.sourceApp
    case 'renderer':
      return PALETTE.sourceRenderer
    default:
      return PALETTE.accent
  }
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function parseUtcTimestamp(ts: string): Date | null {
  const match = ts.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)
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

function formatTime(ts: string): string {
  // Event timestamps are transported as UTC `YYYY-MM-DD HH:MM:SS`; render them
  // in the machine's local timezone while keeping the line compact.
  const date = parseUtcTimestamp(ts)
  if (!date) {
    const idx = ts.indexOf(' ')
    return idx === -1 ? ts : ts.slice(idx + 1)
  }

  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function formatStatus(s: number | null, kind: string): string {
  if (s != null) return String(s)
  switch (kind) {
    case 'rejected':
      return 'REJ'
    case 'upstream_error':
      return 'ERR'
    case 'ws':
      return 'UPG'
    case 'pending':
      return '...'
    default:
      return '---'
  }
}

function formatLatency(ms: number | null): string {
  if (ms == null) return '   -  '
  // Right-align up to 4 digits of ms; overflow just widens (rare case).
  return `${padStart(String(ms), 4)}ms`
}

/// Whether an event represents an error worth highlighting in the stream:
/// upstream errors, rejections, any 4xx/5xx status, or error-level logs.
function isErrorEvent(event: ConsoleEvent): boolean {
  if (event.category === 'request') {
    if (event.kind === 'upstream_error' || event.kind === 'rejected') return true
    if (event.status != null && event.status >= 400) return true
    return false
  }
  return event.level === 'error'
}

/// Block-level highlight applied to error rows so they stand out against the
/// stream of normal lines. Keeps the terminal look — just a red accent.
const ERROR_ROW_STYLE: React.CSSProperties = {
  background: 'rgba(244, 135, 113, 0.12)',
  borderLeft: '2px solid #f48771',
  paddingLeft: 6,
  marginLeft: -8,
}

function RequestLine({ event }: { event: ConsoleRequestEvent }) {
  const kc = kindColor(event.kind)
  const mc = methodColor(event.method)
  const time = formatTime(event.timestamp)
  const method = padEnd(event.method, 4)
  const status = padEnd(formatStatus(event.status, event.kind), 3)
  const latency = formatLatency(event.latencyMs)

  const tail: string[] = []
  if (event.provider) tail.push(event.provider)
  if (event.keyAlias) tail.push(event.keyAlias)
  const whoSuffix = tail.length > 0 ? `  ${tail.join(' / ')}` : ''

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '20px' }}>
      <span style={{ color: PALETTE.dim }}>{`[${time}] `}</span>
      <span style={{ color: kc, fontWeight: 600 }}>{kindGlyph(event.kind)}</span>
      <span> </span>
      <span style={{ color: mc }}>{method}</span>
      <span> </span>
      <span style={{ color: kc, fontWeight: 500 }}>{status}</span>
      <span> </span>
      <span style={{ color: PALETTE.dim }}>{latency}</span>
      <span>{'  '}</span>
      {event.upstream ? (
        <span style={{ color: PALETTE.upstreamAddr }}>{event.upstream}</span>
      ) : (
        <span style={{ color: PALETTE.text }}>{event.path}</span>
      )}
      {whoSuffix ? <span style={{ color: PALETTE.accent }}>{whoSuffix}</span> : null}
      {event.message ? <span style={{ color: PALETTE.note }}>{`  · ${event.message}`}</span> : null}
    </div>
  )
}

function LogLine({ event }: { event: ConsoleLogEvent }) {
  const time = formatTime(event.timestamp)
  const lvl = padEnd(event.level.toUpperCase(), 5)
  const lc = levelColor(event.level)
  const sc = sourceColor(event.source)
  const origin = event.target ? `${event.source}/${event.target}` : event.source

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '20px' }}>
      <span style={{ color: PALETTE.dim }}>{`[${time}] `}</span>
      <span style={{ color: lc, fontWeight: 600 }}>{lvl}</span>
      <span> </span>
      <span style={{ color: sc }}>{origin}</span>
      <span style={{ color: PALETTE.dim }}>{': '}</span>
      <span style={{ color: PALETTE.text }}>{event.message}</span>
    </div>
  )
}

function DetailSection({
  label,
  headers,
  body,
}: {
  label: string
  headers?: string[] | null
  body?: string | null
}) {
  if (!headers?.length && !body) return null
  return (
    <div style={{ paddingLeft: 24, marginTop: 2 }}>
      <span style={{ color: PALETTE.prompt, fontSize: 11 }}>{label}</span>
      {headers?.length ? (
        <div style={{ color: PALETTE.dim, fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 2 }}>
          {headers.map((h, i) => (
            <div key={i}>{h}</div>
          ))}
        </div>
      ) : null}
      {body ? (
        <div
          style={{
            color: PALETTE.text,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            marginTop: 4,
            maxHeight: 120,
            overflowY: 'auto',
          }}
        >
          {body}
        </div>
      ) : null}
    </div>
  )
}

function EventLine({
  event,
  expanded,
  onToggle,
}: {
  event: ConsoleEvent
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const errorStyle = isErrorEvent(event) ? ERROR_ROW_STYLE : undefined
  const hasDetail =
    event.category === 'request' &&
    (event.requestHeaders?.length ||
      event.requestBody ||
      event.responseHeaders?.length ||
      event.responseBody)
  return (
    <div style={errorStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {hasDetail ? (
          <span
            style={{ cursor: 'pointer', color: PALETTE.dim, marginRight: 4, flexShrink: 0 }}
            onClick={onToggle}
          >
            {expanded ? (
              <DownOutlined style={{ fontSize: 10 }} />
            ) : (
              <RightOutlined style={{ fontSize: 10 }} />
            )}
          </span>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {event.category === 'request' ? (
            <>
              <RequestLine event={event} />
              {expanded && hasDetail && (
                <>
                  <DetailSection
                    label={t('console.reqHeaders')}
                    headers={event.requestHeaders}
                    body={event.requestBody}
                  />
                  <DetailSection
                    label={t('console.respHeaders')}
                    headers={event.responseHeaders}
                    body={event.responseBody}
                  />
                </>
              )}
            </>
          ) : (
            <LogLine event={event} />
          )}
        </div>
      </div>
    </div>
  )
}

export default function Console() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const events = useSyncExternalStore(subscribeConsoleStore, getConsoleEvents)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [detailMode, setDetailMode] = useState(false)
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set())
  const visibleEvents = useMemo(
    () => (errorsOnly ? events.filter(isErrorEvent) : events),
    [events, errorsOnly],
  )

  const toggleExpanded = (idx: number) => {
    setExpandedIdx((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  const handleDetailMode = (checked: boolean) => {
    setDetailMode(checked)
    getApi()
      .proxy.setDetailMode(checked)
      .catch(() => {
        setDetailMode(!checked)
      })
  }

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // Track whether the user is "parked" at the bottom; if they've scrolled
  // up to read history, we stop auto-scrolling so new events don't yank them.
  const stickBottomRef = useRef(true)

  useLayoutEffect(() => {
    if (stickBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
    }
  }, [visibleEvents.length])

  const onScrollerScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    // 20px tolerance — subpixel scroll differences shouldn't unparent us.
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickBottomRef.current = dist < 20
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <Space align='center' style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space direction='vertical' size={2}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('console.title')}
          </Typography.Title>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('console.subtitle')}
          </Typography.Text>
        </Space>
        <Space>
          <Space size={6}>
            <Switch size='small' checked={detailMode} onChange={handleDetailMode} />
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              {t('console.detailMode')}
            </Typography.Text>
          </Space>
          <Space size={6}>
            <Switch size='small' checked={errorsOnly} onChange={setErrorsOnly} />
            <Typography.Text type='secondary' style={{ fontSize: 12 }}>
              {t('console.errorsOnly')}
            </Typography.Text>
          </Space>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('console.bufferInfo', { count: events.length, max: CONSOLE_BUFFER_LIMIT })}
          </Typography.Text>
          <Button icon={<ClearOutlined />} onClick={clearConsoleEvents} disabled={!events.length}>
            {t('console.clear')}
          </Button>
        </Space>
      </Space>

      <div
        ref={scrollerRef}
        onScroll={onScrollerScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: PALETTE.bg,
          color: PALETTE.text,
          fontFamily:
            'JetBrains Mono, SFMono-Regular, Menlo, "Cascadia Code", "Courier New", monospace',
          fontSize: 12.5,
          padding: '12px 16px',
          borderRadius: token.borderRadiusLG,
          border: `1px solid ${PALETTE.border}`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.02)',
        }}
      >
        {events.length === 0 ? (
          <div style={{ color: PALETTE.dim, lineHeight: '20px' }}>
            <span style={{ color: PALETTE.prompt }}>▸</span> {t('console.emptyHint')}
          </div>
        ) : visibleEvents.length === 0 ? (
          <div style={{ color: PALETTE.dim, lineHeight: '20px' }}>
            <span style={{ color: PALETTE.prompt }}>▸</span> {t('console.noErrors')}
          </div>
        ) : (
          visibleEvents.map((e, i) => (
            <EventLine
              key={e.category === 'request' && e.requestId ? e.requestId : i}
              event={e}
              expanded={expandedIdx.has(i)}
              onToggle={() => toggleExpanded(i)}
            />
          ))
        )}
      </div>
    </div>
  )
}
