import { useApiKeyStore } from './apiKeyStore'
import { useProjectStore } from './projectStore'
import { useProviderStore } from './providerStore'

/**
 * Re-read the stores that a data import or an Electron migration can change.
 *
 * Those operations used to rebuild the whole WebView, which threw away console
 * history and every page's filters. Reading the affected stores instead keeps
 * the app mounted and updates exactly what the operation touched.
 */
export async function reloadMigratedStores(): Promise<void> {
  await useProviderStore.getState().fetchProviders()
  const providerIds = useProviderStore.getState().providers.map((provider) => provider.id)
  await Promise.all([
    useApiKeyStore.getState().fetchAllApiKeys(providerIds),
    useProjectStore.getState().fetchProjects(),
  ])
}
