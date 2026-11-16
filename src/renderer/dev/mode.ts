/** Deliberately two keys: a production build can never opt in with a URL flag. */
export const isFixtureMode = import.meta.env.DEV && import.meta.env.VITE_CC_USE_FIXTURE === '1'
