import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Button, Dropdown, Input, Space, Switch, Tabs, Tag, Tooltip, Typography, theme } from 'antd'
import { ClearOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  AutoModeAudit,
  ConsoleEvent,
  ConsoleLogEvent,
  ConsoleRequestEvent,
} from '@shared/types'
import {
  CONSOLE_BUFFER_LIMIT,
  clearConsoleHistory,
  getConsoleEvents,
  hydrateConsoleHistory,
  subscribeConsoleStore,
} from '../api/consoleStore'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { getApi } from '../api'

/**
 * Row identity for selection and expansion. Requests keep one row for their
 * whole lifecycle; log records carry an id. Only an event with no identity at
 * all falls back to its position.
 */
function eventRowKey(event: ConsoleEvent, index: number): string {
  if (event.category === 'request') return event.requestId ?? `request-${index}`
  return event.id ?? `log-${index}`
}

/// Terminal palette (VS Code Dark+ inspired). Intentionally not tied to
/// AntD tokens — the console should read like a real terminal regardless
/// of the app's light/dark theme.
const PALETTE = {
  bg: '#1e1e1e',
  border: '#2d2d2d',
  dim: '#8a8a8a',
  text: '#e5e5e5',
  ok: '#4ec9b0',
  cancelled: '#d7ba7d',
  rejected: '#dcdcaa',
  upstreamError: '#f48771',
  ws: '#4fc1ff',
  note: '#ce9178',
  accent: '#9cdcfe',
  prompt: '#6a9955',
  logError: '#f48771',
  logWarn: '#dcdcaa',
  logInfo: '#9cdcfe',
  logDebug: '#8a8a8a',
}

/** Kind labels live in the locale files like every other user-facing string. */
function kindLabel(kind: string, t: (key: string) => string): string {
  const key = `console.kinds.${kind}`
  const translated = t(key)
  return translated === key ? kind : translated
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'ok':
      return PALETTE.ok
    case 'rejected':
      return PALETTE.rejected
    case 'cancelled':
      return PALETTE.cancelled
    case 'upstream_error':
      return PALETTE.upstreamError
    case 'ws':
      return PALETTE.ws
    default:
      return PALETTE.dim
  }
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
  const date = parseUtcTimestamp(ts)
  if (!date) {
    const idx = ts.indexOf(' ')
    return idx === -1 ? ts : ts.slice(idx + 1)
  }
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function formatLatency(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** Whether an event is a problem worth surfacing in the 异常 view. */
function isProblemEvent(event: ConsoleEvent): boolean {
  if (event.category === 'request') {
    if (event.kind === 'upstream_error' || event.kind === 'rejected') return true
    return event.status != null && event.status >= 400
  }
  return event.level === 'error' || event.level === 'warn'
}

/** `Provider / Key`, or a dash when neither is known. */
function routeLabel(event: ConsoleRequestEvent): string {
  const parts = [event.provider, event.keyAlias].filter((value) => value && value.trim())
  return parts.length > 0 ? parts.join(' / ') : '—'
}

/** The short line a user scans: status text, or the error when there is one. */
function requestSummary(event: ConsoleRequestEvent): string {
  if (event.message) return event.message
  if (event.path) return event.path
  return ''
}

function matchesQuery(event: ConsoleEvent, query: string): boolean {
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
      event.status != null ? String(event.status) : null,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  }
  return [event.message, event.target, event.source, event.level]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle))
}

export default function Console() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const events = useSyncExternalStore(subscribeConsoleStore, getConsoleEvents)
  const [view, setView] = useState<'requests' | 'problems' | 'logs'>('requests')
  const [query, setQuery] = useState('')
  const [detailMode, setDetailMode] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [newCount, setNewCount] = useState(0)

  const requestEvents = useMemo(
    () => events.filter((event) => event.category === 'request'),
    [events],
  )
  const problemEvents = useMemo(() => events.filter(isProblemEvent), [events])
  const logEvents = useMemo(() => events.filter((event) => event.category === 'log'), [events])

  const visibleEvents = useMemo(() => {
    const base =
      view === 'requests' ? requestEvents : view === 'problems' ? problemEvents : logEvents
    return query ? base.filter((event) => matchesQuery(event, query)) : base
  }, [view, requestEvents, problemEvents, logEvents, query])

  const selected = useMemo(() => {
    if (!selectedKey) return null
    return visibleEvents.find((event, index) => eventRowKey(event, index) === selectedKey) ?? null
  }, [selectedKey, visibleEvents])

  // The capture flag lives in the daemon, so the switch reflects what the
  // daemon is actually doing rather than what this page last asked for.
  const syncDetailMode = useCallback(async () => {
    try {
      setDetailMode(await getApi().proxy.getDetailMode())
    } catch {
      // The daemon may not be up yet; leave the switch as-is rather than
      // showing a state we could not confirm.
    }
  }, [])

  useEffect(() => {
    void syncDetailMode()
  }, [syncDetailMode])

  usePageRefresh(async () => {
    await Promise.all([hydrateConsoleHistory(), syncDetailMode()])
  })

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
  const knownCountRef = useRef(visibleEvents.length)

  useLayoutEffect(() => {
    const grew = visibleEvents.length > knownCountRef.current
    knownCountRef.current = visibleEvents.length
    if (!grew) return
    if (stickBottomRef.current && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
      setNewCount(0)
      return
    }
    // Following is paused; say how much arrived rather than moving the view.
    setNewCount((count) => count + 1)
  }, [visibleEvents.length])

  const onScrollerScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickBottomRef.current = dist < 20
    if (stickBottomRef.current) setNewCount(0)
  }

  const jumpToLatest = () => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    stickBottomRef.current = true
    setNewCount(0)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      <Space className='justify-between w-full' wrap>
        <Tabs
          activeKey={view}
          onChange={(key) => setView(key as typeof view)}
          items={[
            { key: 'requests', label: t('console.viewRequests') || '请求' },
            {
              key: 'problems',
              label: `${t('console.viewProblems') || '异常'} ${problemEvents.length}`,
            },
            { key: 'logs', label: t('console.viewLogs') || '运行日志' },
          ]}
        />
        <Space wrap>
          <Input.Search
            allowClear
            size='small'
            style={{ width: 220 }}
            placeholder={t('console.searchPlaceholder') || '搜索模型、Key、错误…'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Tooltip title={t('console.detailModeHint') || '控制台是否保存请求 / 响应明细'}>
            <Space size={4}>
              <Switch size='small' checked={detailMode} onChange={handleDetailMode} />
              <Typography.Text type='secondary' style={{ fontSize: 12 }}>
                {t('console.detailMode')}
              </Typography.Text>
            </Space>
          </Tooltip>
          <Typography.Text type='secondary' style={{ fontSize: 12 }}>
            {t('console.bufferInfo', { count: events.length, max: CONSOLE_BUFFER_LIMIT })}
          </Typography.Text>
          <Button
            size='small'
            icon={<ReloadOutlined />}
            onClick={() => void hydrateConsoleHistory()}
          >
            {t('common.refresh')}
          </Button>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'clear',
                  icon: <ClearOutlined />,
                  label: t('console.clear'),
                  onClick: () => {
                    // Clears the on-disk history of both processes too, so a
                    // reload cannot bring back what the user just deleted.
                    void clearConsoleHistory()
                    setSelectedKey(null)
                  },
                },
              ],
            }}
          >
            <Button size='small'>{t('console.more') || '更多'}</Button>
          </Dropdown>
        </Space>
      </Space>

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
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
              padding: '8px 12px',
              borderRadius: token.borderRadiusLG,
              border: `1px solid ${PALETTE.border}`,
            }}
          >
            {visibleEvents.length === 0 ? (
              <div style={{ color: PALETTE.dim, lineHeight: '20px' }}>
                <span style={{ color: PALETTE.prompt }}>▸</span>{' '}
                {view === 'problems' ? t('console.noProblems') : t('console.emptyHint')}
              </div>
            ) : (
              visibleEvents.map((event, index) => {
                const key = eventRowKey(event, index)
                return event.category === 'request' ? (
                  <RequestRow
                    key={key}
                    event={event}
                    selected={selectedKey === key}
                    onSelect={() => setSelectedKey(key)}
                  />
                ) : (
                  <LogRow key={key} event={event} />
                )
              })
            )}
          </div>

          {newCount > 0 && (
            <Button
              size='small'
              type='primary'
              onClick={jumpToLatest}
              style={{
                position: 'absolute',
                bottom: 12,
                left: '50%',
                transform: 'translateX(-50%)',
              }}
            >
              {t('console.newEvents', { count: newCount })}
            </Button>
          )}
        </div>

        {selected?.category === 'request' && (
          <RequestDetail event={selected} onClose={() => setSelectedKey(null)} />
        )}
      </div>
    </div>
  )
}

/** One request: time, status, model, route, latency and a short summary. */
function RequestRow({
  event,
  selected,
  onSelect,
}: {
  event: ConsoleRequestEvent
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const color = kindColor(event.kind)
  const isProblem = isProblemEvent(event)
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        gap: 10,
        lineHeight: '20px',
        cursor: 'pointer',
        padding: '1px 4px',
        borderRadius: 3,
        background: selected ? 'rgba(156, 220, 254, 0.15)' : undefined,
        borderLeft: isProblem ? `2px solid ${PALETTE.upstreamError}` : '2px solid transparent',
      }}
    >
      <span style={{ color: PALETTE.dim, flexShrink: 0 }}>{formatTime(event.timestamp)}</span>
      <span style={{ color, flexShrink: 0, width: 64 }}>{kindLabel(event.kind, t)}</span>
      <span
        style={{
          flexShrink: 0,
          width: 190,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          overflow: 'hidden',
        }}
      >
        {/* The model name yields space first; the Auto label must stay. */}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {event.model || '—'}
        </span>
        {event.requestKind === 'auto_mode' && (
          <Tag color='gold' style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '15px' }}>
            Auto
          </Tag>
        )}
      </span>
      <span
        style={{
          color: PALETTE.accent,
          flexShrink: 0,
          width: 150,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {routeLabel(event)}
      </span>
      <span style={{ color: PALETTE.dim, flexShrink: 0, width: 56, textAlign: 'right' }}>
        {formatLatency(event.latencyMs)}
      </span>
      <span
        style={{
          color: PALETTE.note,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {requestSummary(event)}
      </span>
    </div>
  )
}

function LogRow({ event }: { event: ConsoleLogEvent }) {
  const origin = event.target ? `${event.source}/${event.target}` : event.source
  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '20px' }}>
      <span style={{ color: PALETTE.dim }}>{`[${formatTime(event.timestamp)}] `}</span>
      <span style={{ color: levelColor(event.level), fontWeight: 600 }}>
        {event.level.toUpperCase().padEnd(5)}
      </span>
      <span> </span>
      <span style={{ color: PALETTE.accent }}>{origin}</span>
      <span style={{ color: PALETTE.dim }}>{': '}</span>
      <span style={{ color: PALETTE.text }}>{event.message}</span>
    </div>
  )
}

/** What happened, then the request and response detail on demand. */
function RequestDetail({ event, onClose }: { event: ConsoleRequestEvent; onClose: () => void }) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [tab, setTab] = useState('summary')
  const [audit, setAudit] = useState<AutoModeAudit | null>(null)

  useEffect(() => {
    setTab('summary')
    setAudit(null)
    if (event.requestKind !== 'auto_mode' || !event.requestId) return
    let cancelled = false
    // The audit is the record of what the classifier was asked and answered.
    getApi()
      .autoModeAudit.get(event.requestId)
      .then((row) => {
        if (!cancelled) setAudit(row)
      })
      .catch(() => {
        if (!cancelled) setAudit(null)
      })
    return () => {
      cancelled = true
    }
  }, [event.requestId, event.requestKind])

  const hasDetail = Boolean(
    event.requestHeaders?.length ||
    event.requestBody ||
    event.responseHeaders?.length ||
    event.responseBody,
  )

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value)
  }

  return (
    <div
      style={{
        width: 380,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${PALETTE.border}`,
        borderRadius: token.borderRadiusLG,
        background: PALETTE.bg,
        color: PALETTE.text,
        padding: 12,
        gap: 8,
        overflow: 'auto',
      }}
    >
      <Space className='justify-between w-full'>
        <Space size={6} wrap>
          <Tag color={event.kind === 'ok' ? 'green' : 'default'}>{kindLabel(event.kind, t)}</Tag>
          <Typography.Text style={{ color: PALETTE.text }}>{event.model || '—'}</Typography.Text>
          {event.requestKind === 'auto_mode' && <Tag color='gold'>Auto</Tag>}
          <Typography.Text style={{ color: PALETTE.dim, fontSize: 12 }}>
            {formatLatency(event.latencyMs)}
          </Typography.Text>
        </Space>
        <Button type='text' size='small' onClick={onClose} style={{ color: PALETTE.dim }}>
          ✕
        </Button>
      </Space>

      <Space size={4} wrap>
        <Typography.Text style={{ color: PALETTE.accent, fontSize: 12 }}>
          {routeLabel(event)}
        </Typography.Text>
        {event.requestId && (
          <Tooltip title={t('console.copyRequestId') || '复制请求 ID'}>
            <Button
              type='text'
              size='small'
              icon={<CopyOutlined />}
              onClick={() => copy(event.requestId!)}
              style={{ color: PALETTE.dim }}
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
            label: t('console.summary') || '概要',
            children: (
              <Space direction='vertical' size={6} style={{ fontSize: 12 }}>
                <div style={{ color: PALETTE.dim }}>{t('console.upstream') || '上游'}</div>
                <div style={{ wordBreak: 'break-all' }}>{event.upstream || event.path}</div>
                {event.status != null && (
                  <div style={{ color: PALETTE.dim }}>HTTP {event.status}</div>
                )}
                {event.message && <div style={{ color: PALETTE.note }}>{event.message}</div>}
                {event.kind === 'ws' && (
                  <div style={{ color: PALETTE.ws }}>
                    {t('console.wsUpgraded') ||
                      '连接已升级：这是代理建连成功，不代表一次模型生成已经完成'}
                  </div>
                )}
                {audit && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ color: PALETTE.dim }}>
                      {t('statistics.autoAuditAction') || '待审核动作'}
                    </div>
                    <div>
                      {audit.actionSummary || t('statistics.autoAuditUnknownAction') || '未识别'}
                    </div>
                    <div style={{ color: PALETTE.dim }}>
                      {t('statistics.autoAuditVerdict') || '模型返回'}
                    </div>
                    <div>
                      {audit.parseOk && audit.verdict
                        ? audit.verdict === 'block'
                          ? t('statistics.verdictBlock')
                          : t('statistics.verdictNoBlock')
                        : t('statistics.verdictUnknown')}
                    </div>
                    <div style={{ color: PALETTE.dim }}>
                      {t('statistics.autoAuditClient') || '客户端执行'}
                    </div>
                    <div>{audit.clientOutcome || t('statistics.autoAuditNotObserved')}</div>
                  </div>
                )}
              </Space>
            ),
          },
          {
            key: 'request',
            label: t('console.reqHeaders') || '请求',
            children: hasDetail ? (
              <DetailSection
                label={t('console.reqHeaders')}
                headers={event.requestHeaders}
                body={event.requestBody}
              />
            ) : (
              <Typography.Text style={{ color: PALETTE.dim, fontSize: 12 }}>
                {t('console.detailNotCaptured') || '当时未开启详情采集'}
              </Typography.Text>
            ),
          },
          {
            key: 'response',
            label: t('console.respHeaders') || '响应',
            children: hasDetail ? (
              <DetailSection
                label={t('console.respHeaders')}
                headers={event.responseHeaders}
                body={event.responseBody}
              />
            ) : (
              <Typography.Text style={{ color: PALETTE.dim, fontSize: 12 }}>
                {t('console.detailNotCaptured') || '当时未开启详情采集'}
              </Typography.Text>
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
}: {
  label: string
  headers?: string[] | null
  body?: string | null
}) {
  return (
    <div>
      <div style={{ color: PALETTE.prompt, fontSize: 11 }}>{label}</div>
      {headers?.length ? (
        <div style={{ color: PALETTE.dim, fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 2 }}>
          {headers.map((header, index) => (
            <div key={index}>{header}</div>
          ))}
        </div>
      ) : null}
      {body ? (
        <pre
          style={{
            color: PALETTE.text,
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginTop: 4,
          }}
        >
          {body}
        </pre>
      ) : null}
    </div>
  )
}

export { eventRowKey, isProblemEvent, matchesQuery }
