/**
 * The shared query configuration section — the switch, the scheme choice, the
 * custom-script entry and the draft test, identical for the account and the
 * key scope.
 *
 * The section owns only what both scopes share. It never knows what a
 * provider or a key is: callers pass the current `value` (`enabled` /
 * `schemeId` / `script`), receive `onChange` on every user action, and supply
 * `onDraftTest` so the credentials and the address of a draft test stay with
 * the opening modal. `scope` alone decides the scheme catalogue, the test
 * inputs and what a result may show.
 *
 * User decisions drive everything (D3): opening a modal, prefilling text or
 * recognising a stored script never flips the switch — only the switch itself
 * or picking a named scheme enables the query. Turning the switch off keeps
 * the scheme and the script text (D4); nothing here blanks them.
 */
import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Button, Input, Select, Switch, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import type { QueryScope, QuerySchemeInfo, QueryTestInput, QueryTestResult } from '@shared/types'
import { formatAccountAmount } from '../../utils/accountQuery'
import ProviderUsageWindows from '../providers/ProviderUsageWindows'
import styles from './QuerySettingsSection.module.css'

const { Text } = Typography
const { TextArea } = Input

/** The query state of the opening modal: switch, scheme and script text. */
export interface QueryScriptValue {
  enabled: boolean
  /** A catalogue id, `custom`, or `''` on a draft nothing was chosen for yet. */
  schemeId: string
  script: string
}

/**
 * The parts of a draft test the section itself holds. The instantiating modal
 * completes the address and the credentials (account scope borrows and/or the
 * account token/user id; key scope the key value) and returns the result.
 */
export type QuerySectionTestInput = Pick<QueryTestInput, 'scope' | 'script'>

const CUSTOM_SCHEME_ID = 'custom'

interface QuerySettingsSectionProps {
  scope: QueryScope
  /** Pass one stable object identity per value change; see the A6 note below. */
  value: QueryScriptValue
  onChange: (next: QueryScriptValue) => void
  testVisible: boolean
  /**
   * Identity is the input-freshness signal (A6): when the modal rebuilds the
   * test input (address, proxy, credentials), reinstalling this function must
   * invalidate what an earlier run of it returned. Memoize with `useCallback`.
   */
  onDraftTest: (input: QuerySectionTestInput) => Promise<QueryTestResult>
  className?: string
  /** Account scope: one line explaining where the account credential lives. */
  accountCredentialHint?: string | null
}

export default function QuerySettingsSection({
  scope,
  value,
  onChange,
  testVisible,
  onDraftTest,
  className,
  accountCredentialHint,
}: QuerySettingsSectionProps) {
  const { t } = useTranslation()
  const [schemes, setSchemes] = useState<QuerySchemeInfo[]>([])
  /** The revision whose test run owns the on-screen spinner. */
  const [claimedRevision, setClaimedRevision] = useState<number | null>(null)
  const [result, setResult] = useState<QueryTestResult | null>(null)
  /** The custom code editor is entered, never shown by default (A1). */
  const [editorOpen, setEditorOpen] = useState(false)
  /**
   * Monotonic revision of `value` / test inputs. The effect also runs on
   * mount, which is harmless: the revision simply starts past zero.
   */
  const revisionRef = useRef(0)
  /**
   * D3 record: picking a named scheme is the most recent user decision that
   * turned the query on, as opposed to the switch itself. Kept internal so the
   * component can tell a scheme-driven enable from a switch-driven one.
   */
  const lastSelectedWasChoiceRef = useRef(false)

  // A reference change means a new value or a rebuilt test input: a displayed
  // test result belongs to a configuration that no longer exists, so it is
  // cleared and a pending response loses its claim (A6).
  useEffect(() => {
    revisionRef.current += 1
    setResult(null)
  }, [value, onDraftTest])

  // A named scheme hides the code again: the catalogue is the friendly path,
  // and the script text only reappears through the custom affordances (A1).
  useEffect(() => {
    if (value.schemeId !== CUSTOM_SCHEME_ID) setEditorOpen(false)
  }, [value.schemeId])

  const catalogueRevisionRef = useRef(0)
  useEffect(() => {
    const revision = ++catalogueRevisionRef.current
    let active = true
    getApi()
      .balance.schemes(scope)
      .then((list) => {
        if (active && revision === catalogueRevisionRef.current) setSchemes(list)
      })
      .catch(() => {
        // Without the catalogue the switch and the stored script still work;
        // the user sees the custom entry with their text preserved.
        if (active && revision === catalogueRevisionRef.current) setSchemes([])
      })
    return () => {
      active = false
    }
  }, [scope])

  const selectedScheme = schemes.find((scheme) => scheme.id === value.schemeId)
  const scriptMatchesCatalogue = schemes.some((scheme) => scheme.script === value.script)
  const storedScriptIsUnrecognised = Boolean(value.script.trim()) && !scriptMatchesCatalogue
  // The explicit custom entry appears exactly when the stored text is not the
  // catalogue's text — the user's script stays reachable without ever being
  // hidden behind a wrong-looking named scheme (A5).
  const showCustomEntry = value.schemeId === CUSTOM_SCHEME_ID || storedScriptIsUnrecognised
  // The code is hidden entirely while a pure catalogue state is shown (A1):
  // a named scheme with text byte-identical to it. A named scheme whose stored
  // text no longer matches may reveal its text behind the explicit entry.
  const schemeStateIsPure = Boolean(selectedScheme) && scriptMatchesCatalogue
  const editorShown = editorOpen && !schemeStateIsPure

  const schemeOptions = [
    ...schemes.map((scheme) => ({ value: scheme.id, label: t(scheme.labelKey) })),
    { value: CUSTOM_SCHEME_ID, label: t('querySchemes.customize') },
  ]

  const descriptionLine = selectedScheme
    ? t(selectedScheme.descriptionKey)
    : value.schemeId === CUSTOM_SCHEME_ID || storedScriptIsUnrecognised
      ? t('querySchemes.customHint')
      : ''

  const credentialLabels = (selectedScheme?.credentialRequirements ?? []).map((credential) =>
    t(`querySchemes.credential${credential.charAt(0).toUpperCase()}${credential.slice(1)}`),
  )

  const handleSchemeChange = (nextId: string) => {
    if (nextId === CUSTOM_SCHEME_ID) {
      // Custom is the advanced path: the switch stays as the user left it, the
      // script text is untouched, and the editor still needs its explicit click.
      lastSelectedWasChoiceRef.current = false
      onChange({ ...value, schemeId: CUSTOM_SCHEME_ID })
      return
    }
    const scheme = schemes.find((item) => item.id === nextId)
    if (!scheme) return
    // One user decision, one state write: picking a named scheme is the
    // explicit enable (D3) and writes the scheme's script in the same change.
    lastSelectedWasChoiceRef.current = true
    onChange({ enabled: true, schemeId: scheme.id, script: scheme.script })
  }

  const handleEnabledChange = (checked: boolean) => {
    // The switch is the only place the query changes state without being asked
    // to prove a scheme: nothing above it enables on behalf of the user (D3).
    lastSelectedWasChoiceRef.current = false
    onChange({ ...value, enabled: checked })
  }

  const handleScriptChange = (script: string) => {
    onChange({ ...value, script })
  }

  const openCustomFromScheme = () => {
    setEditorOpen(true)
    // `basedOnScheme` keeps the script verbatim — the point is to start from
    // the current text (a scheme's or a variant of it), never to rewrite it.
    lastSelectedWasChoiceRef.current = false
    onChange({ ...value, schemeId: CUSTOM_SCHEME_ID })
  }

  const openCustomEditor = () => {
    // The explicit entry reveals the stored text verbatim. It does NOT move
    // the scheme marker: a mismatched stored script under a named scheme is
    // kept exactly as configured until the user picks another scheme or
    // chooses `basedOnScheme` (A5/D5).
    setEditorOpen(true)
    lastSelectedWasChoiceRef.current = false
  }

  const scriptMissing = !value.script.trim()

  const runTest = async () => {
    if (scriptMissing) return
    // Launching a test is itself a revision: an older launch loses its claim.
    const revision = ++revisionRef.current
    setClaimedRevision(revision)
    setResult(null)
    try {
      const response = await onDraftTest({ scope, script: value.script })
      if (revision === revisionRef.current) setResult(response)
    } catch (error) {
      if (revision === revisionRef.current) {
        // No raw network detail is ever rendered; a thrown rejection carries a
        // domain string or an already-redacted message from the backend.
        setResult({
          scope,
          usage: null,
          isValid: false,
          invalidMessage: null,
          error: String(error),
        })
      }
    } finally {
      // This run's spinner ends with this run: an abandoned (revision-replaced)
      // launch stops its own spinner without ending a newer one.
      setClaimedRevision((claimed) => (claimed === revision ? null : claimed))
    }
  }

  const failureMessage =
    result === null
      ? null
      : result.isValid && !result.error && !result.invalidMessage && result.usage !== null
        ? null
        : result.error || result.invalidMessage || t('querySchemes.testFailed')
  const testing = claimedRevision !== null && claimedRevision === revisionRef.current

  return (
    <div className={`${styles.section} ${className ?? ''}`}>
      {scope === 'account' && accountCredentialHint && (
        <Text type='secondary' className={styles.hint}>
          {accountCredentialHint}
        </Text>
      )}

      <div className={styles.switchRow}>
        <Switch
          checked={value.enabled}
          onChange={handleEnabledChange}
          aria-label={t('querySchemes.enabledLabel')}
        />
        <Text>{t('querySchemes.enabledLabel')}</Text>
      </div>

      <Select
        value={value.schemeId || undefined}
        onChange={handleSchemeChange}
        options={schemeOptions}
        placeholder={t('querySchemes.schemePlaceholder')}
        className={styles.schemeSelect}
        aria-label={t('querySchemes.schemeSelectLabel')}
      />
      <Text type='secondary' className={styles.description}>
        {descriptionLine}
      </Text>

      {selectedScheme && (
        <div className={styles.capabilities}>
          <Tag>
            {t(
              selectedScheme.supportsWindows
                ? 'querySchemes.capabilityWindows'
                : 'querySchemes.capabilityAmount',
            )}
          </Tag>
          {credentialLabels.map((label) => (
            <Tag key={label}>{label}</Tag>
          ))}
        </div>
      )}

      <div className={styles.actions}>
        {testVisible && (
          <>
            <Button
              size='small'
              onClick={() => void runTest()}
              loading={testing}
              disabled={scriptMissing}
            >
              {t('querySchemes.test')}
            </Button>
            {scriptMissing && <Text type='secondary'>{t('querySchemes.testNeedScript')}</Text>}
            {testing && (
              <Text type='secondary' role='status'>
                {t('querySchemes.testing')}
              </Text>
            )}
          </>
        )}
        {showCustomEntry && !editorShown && (
          <Button size='small' onClick={openCustomEditor}>
            {t('querySchemes.customize')}
          </Button>
        )}
        {selectedScheme && !editorShown && (
          <Button size='small' type='link' onClick={openCustomFromScheme}>
            {t('querySchemes.basedOnScheme')}
          </Button>
        )}
      </div>

      {/* The code only exists on an explicit entry; the user's text shows in
          full so nothing is lost by the reveal (A5). */}
      {editorShown && (
        <TextArea
          value={value.script}
          onChange={(event) => handleScriptChange(event.target.value)}
          autoSize={{ minRows: 6, maxRows: 14 }}
          spellCheck={false}
          className={styles.editor}
          aria-label={t('querySchemes.customScriptLabel')}
        />
      )}

      {/* A failure is never a success, and a success never a failure. Nothing
          raw (response, URL, headers) is rendered; a failure shows the wordier
          of the backend's reasons. */}
      {failureMessage !== null && (
        <div className={styles.result} role='alert'>
          <Text type='danger'>{failureMessage}</Text>
        </div>
      )}
      {result !== null && failureMessage === null && result.usage !== null && (
        <div className={styles.result} role='status'>
          <Text>{t('querySchemes.testSuccess')}</Text>
          <div className={styles.resultRow}>
            <Text type='secondary'>{t('querySchemes.resultRemaining')}</Text>
            <Text strong>
              {result.usage.isUnlimited
                ? '∞'
                : formatAccountAmount(result.usage.remaining, result.usage.unit)}
            </Text>
          </div>
          {result.usage.expireAt && (
            <div className={styles.resultRow}>
              <Text type='secondary'>{t('querySchemes.resultExpireAt')}</Text>
              <Text>{dayjs(result.usage.expireAt).format('YYYY-MM-DD HH:mm')}</Text>
            </div>
          )}
          {/* Metering periods belong to the account question only. The key
              scope strips them server-side; nothing about them is rendered even
              if a rogue answer carried them (D1). */}
          {scope === 'account' && (
            <ProviderUsageWindows
              windows={result.usage.windows ?? []}
              groups={result.usage.groups ?? []}
            />
          )}
        </div>
      )}
    </div>
  )
}
