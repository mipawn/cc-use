import { getApi } from '../../api'
import { useState, useCallback } from 'react'
import { Typography } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { FolderOpenOutlined, CloudUploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import styles from './DropZone.module.css'

const { Text } = Typography

interface DropZoneProps {
  onDrop: (path: string) => void
  disabled?: boolean
  hint?: string
}

export default function DropZone({ onDrop, disabled = false, hint }: DropZoneProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [isDragging, setIsDragging] = useState(false)

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) {
        setIsDragging(true)
      }
    },
    [disabled],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragging to false if we're leaving the drop zone entirely
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      const files = e.dataTransfer.files
      if (files.length === 0) {
        message.error(t('dropZone.noFilesDropped'))
        return
      }

      const file = files[0]
      // Get the path from the dropped file
      const path = (file as File & { path?: string }).path

      if (!path) {
        message.error(t('dropZone.couldNotGetPath'))
        return
      }

      onDrop(path)
    },
    [onDrop, t],
  )

  const handleClick = async () => {
    if (disabled) return
    try {
      const path = await getApi().system.selectFolder()
      if (path) {
        onDrop(path)
      }
    } catch (error) {
      console.error('Failed to select folder:', error)
      message.error(t('dropZone.couldNotGetPath'))
    }
  }

  return (
    <div
      onClick={handleClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`${styles.dropZone} ${isDragging ? styles.dragging : ''} ${disabled ? styles.disabled : ''}`}
    >
      {/* Background Grid Pattern */}
      <div className={styles.gridPattern} />

      {/* Gradient Overlay */}
      <div className={styles.gradientOverlay} />

      {/* Content */}
      <div className={styles.content}>
        <div className={styles.iconContainer}>
          <div className={styles.iconRing}>
            {isDragging ? (
              <CloudUploadOutlined className={styles.icon} />
            ) : (
              <FolderOpenOutlined className={styles.icon} />
            )}
          </div>
          {isDragging && <div className={styles.iconPulse} />}
        </div>

        <div className={styles.textContent}>
          <Text className={styles.title}>{t('dashboard.dropZone')}</Text>
          <Text type='secondary' className={styles.hint}>
            {hint || t('dashboard.dropZoneHint')}
          </Text>
        </div>

        {/* Keyboard hint */}
        <div className={styles.keyboardHint}>
          <kbd className={styles.kbd}>⌘</kbd>
          <span>+</span>
          <kbd className={styles.kbd}>O</kbd>
        </div>
      </div>

      {/* Corner Accents */}
      <div className={`${styles.corner} ${styles.cornerTopLeft}`} />
      <div className={`${styles.corner} ${styles.cornerTopRight}`} />
      <div className={`${styles.corner} ${styles.cornerBottomLeft}`} />
      <div className={`${styles.corner} ${styles.cornerBottomRight}`} />
    </div>
  )
}
