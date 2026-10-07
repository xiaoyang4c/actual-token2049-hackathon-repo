import {useCallback, useEffect, useState} from 'react'

/** Load once per key; `reload` runs the loader again. */
export function useAsync<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{data: T | null; error: string | null; loading: boolean}>({data: null, error: null, loading: true})

  const run = useCallback(() => {
    let live = true
    setState((s) => ({...s, loading: true, error: null}))
    load()
      .then((data) => { if (live) setState({data, error: null, loading: false}) })
      .catch((error: unknown) => { if (live) setState((s) => ({...s, error: error instanceof Error ? error.message : String(error), loading: false})) })
    return () => { live = false }
    // The key identifies the request; the loader closes over the same inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => run(), [run])
  return {...state, reload: run}
}
