import type { ClientKind } from '@shared/types'
import claudeIcon from '../../assets/claude-icon.svg'
import codexIcon from '../../assets/codex-icon.svg'
import grokIcon from '../../assets/grok-icon.svg'
import styles from './ClientIcon.module.css'

/** Brand marks, with terminal / desktop badges to distinguish the two Claude clients. */
export default function ClientIcon({ kind, size = 20 }: { kind: ClientKind; size?: number }) {
  const isClaude = kind === 'claude_code' || kind === 'claude_desktop'
  const src = kind === 'grok' ? grokIcon : codexIcon
  return (
    <span
      className={styles.root}
      style={{ width: size, height: size }}
      aria-hidden='true'
      data-client-icon={kind}
    >
      {isClaude ? (
        <img className={styles.mark} src={claudeIcon} alt='' />
      ) : (
        <span
          className={styles.monochrome}
          style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` }}
        />
      )}
      {isClaude && (
        <span className={styles.badge}>
          <svg
            viewBox='0 0 16 16'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.8'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            {kind === 'claude_code' ? (
              <>
                <path d='m3 4 4 4-4 4' />
                <path d='M9 12h4' />
              </>
            ) : (
              <>
                <rect x='2' y='2.5' width='12' height='8.5' rx='1' />
                <path d='M8 11v2.5M5 13.5h6' />
              </>
            )}
          </svg>
        </span>
      )}
    </span>
  )
}
