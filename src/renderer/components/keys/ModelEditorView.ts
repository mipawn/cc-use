import { useEffect, useRef } from 'react'

export interface ModelEditorActions {
  confirm?: () => void
  back: () => void
  confirmText?: string
}

/** Keep the modal footer registered while its handlers read the latest draft. */
export function useModelEditorActions(
  onChange: (actions: ModelEditorActions | null) => void,
  actions: ModelEditorActions,
) {
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    onChange({
      confirm: actions.confirm ? () => latest.current.confirm?.() : undefined,
      back: () => latest.current.back(),
      confirmText: actions.confirmText,
    })
    return () => onChange(null)
  }, [onChange, actions.confirmText, Boolean(actions.confirm)])
}
