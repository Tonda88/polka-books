import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { directProviders } from '../discovery/direct';
import { fetchProviders } from '../discovery/api';

/**
 * Источники и режим поиска для интерфейса.
 * При недоступности внешнего сервера не показываем аварийный экран:
 * встроенные бесплатные источники продолжают работать.
 */
export function usePreferences() {
  const app = useApp();
  const [providersOnline, setProvidersOnline] = useState<boolean | null>(null);
  const [serverProviders, setServerProviders] = useState<Awaited<ReturnType<typeof fetchProviders>>['providers']>([]);

  const keys = {
    googleCseKey: app.state.settings.googleCseKey ?? null,
    googleCseCx: app.state.settings.googleCseCx ?? null,
    bingKey: app.state.settings.bingKey ?? null,
  };
  const deviceProviders = directProviders(keys);
  const providers = providersOnline ? serverProviders : deviceProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    requiresKey: provider.requiresKey,
    note: provider.note,
    available: provider.available,
  }));

  const refresh = useCallback(async () => {
    const result = await fetchProviders();
    setProvidersOnline(result.online);
    setServerProviders(result.providers);
    return result;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, app.state.settings.searchServerUrl]);

  return {
    mode: providersOnline ? 'server' as const : 'device' as const,
    providers,
    providersOnline,
    keys,
    refresh,
  };
}
