import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Space, Typography, theme } from 'antd'
import { ClearOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  ConsoleEvent,
  ConsoleLogEvent,
  ConsoleRequestEvent,
} from '../../shared/types'
import { getApi } from '../api'
import { subscribeRendererConsole } from '../api/consoleBus'

/// How many lines we retain. 500 feels like "scrollable recent history"
/// without making the DOM painful.
const BUFFER_LIMIT = 500

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

function formatTime(ts: string): string {
  // Event timestamps are "YYYY-MM-DD HH:MM:SS"; the console is live so we
  // only surface the time-of-day — keeps the line short and readable.
  const idx = ts.indexOf(' ')
  return idx === -1 ? ts : ts.slice(idx + 1)
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
    default:
      return '---'
  }
}

function formatLatency(ms: number | null): string {
  if (ms == null) return '   -  '
  // Right-align up to 4 digits of ms; overflow just widens (rare case).
  return `${padStart(String(ms), 4)}ms`
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
      <span>{' '}</span>
      <span style={{ color: mc }}>{method}</span>
      <span>{' '}</span>
      <span style={{ color: kc, fontWeight: 500 }}>{status}</span>
      <span>{' '}</span>
      <span style={{ color: PALETTE.dim }}>{latency}</span>
      <span>{'  '}</span>
      {event.upstream ? (
        <span style={{ color: PALETTE.upstreamAddr }}>{event.upstream}</span>
      ) : (
        <span style={{ color: PALETTE.text }}>{event.path}</span>
      )}
      {whoSuffix ? <span style={{ color: PALETTE.accent }}>{whoSuffix}</span> : null}
      {event.message ? (
        <span style={{ color: PALETTE.note }}>{`  · ${event.message}`}</span>
      ) : null}
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
      <span>{' '}</span>
      <span style={{ color: sc }}>{origin}</span>
      <span style={{ color: PALETTE.dim }}>{': '}</span>
      <span style={{ color: PALETTE.text }}>{event.message}</span>
    </div>
  )
}

function EventLine({ event }: { event: ConsoleEvent }) {
  return event.category === 'request' ? (
    <RequestLine event={event} />
  ) : (
    <LogLine event={event} />
  )
}

export default function Console() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [events, setEvents] = useState<ConsoleEvent[]>([])

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  // Track whether the user is "parked" at the bottom; if they've scrolled
  // up to read history, we stop auto-scrolling so new events don't yank them.
  const stickBottomRef = useRef(true)

  const push = (event: ConsoleEvent) => {
    setEvents((prev) => {
      const next = prev.concat(event)
      return next.length > BUFFER_LIMIT ? next.slice(next.length - BUFFER_LIMIT) : next
    })
  }

  useEffect(() => {
    // Two sources feed the same buffer: Tauri event channel carries daemon
    // (forwarded via SSE bridge) + app-local Rust logs + proxy requests;
    // the renderer bus carries in-process `console.*` calls.
    const unlistenTauri = getApi().console.onEvent(push)
    const unlistenBus = subscribeRendererConsole(push)
    return () => {
      unlistenTauri()
      unlistenBus()
    }
  }, [])

  useLayoutEffect(() => {
    if (stickBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
    }
  }, [events.length])

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
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('console.bufferInfo', { count: events.length, max: BUFFER_LIMIT })}
          </Typography.Text>
          <Button
            icon={<ClearOutlined />}
            onClick={() => setEvents([])}
            disabled={!events.length}
          >
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
        ) : (
          events.map((e, i) => <EventLine key={i} event={e} />)
        )}
      </div>
    </div>
  )
}
