import ServiceStatusPill from './ServiceStatusPill'

export default function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        position: 'relative',
        flexShrink: 0,
        // macOS: leave space for traffic lights on the left
        paddingLeft: 80,
        paddingRight: 12,
        gap: 8,
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      <ServiceStatusPill />
    </div>
  )
}
