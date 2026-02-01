import { useEffect } from 'react';
import { ConfigProvider, Input, Button, Tooltip, message } from 'antd';
import {
  SearchOutlined,
  PlusOutlined,
  ImportOutlined,
  ExportOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { useProvidersStore } from './stores/providers';
import { useCommonStore } from './stores/common';
import { useUIStore, t } from './stores/ui';
import { theme } from './styles/theme';
import Header from './components/layout/Header';
import ProviderGrid from './components/providers/ProviderGrid';
import ProviderDrawer from './components/providers/ProviderDrawer';
import CommonDrawer from './components/common/CommonDrawer';
import AboutModal from './components/AboutModal';
import TypeTabs from './components/TypeTabs';
import type { Config } from './api/client';
import { exportConfig, importConfig } from './api/client';

function App() {
  const { providers, loading: providersLoading, fetchProviders } = useProvidersStore();
  const { fetchCommon } = useCommonStore();
  const {
    language,
    searchText,
    setSearchText,
    filterType,
    setFilterType,
    openDrawer,
    setCommonDrawerOpen,
  } = useUIStore();

  useEffect(() => {
    fetchProviders();
    fetchCommon();
  }, [fetchProviders, fetchCommon]);

  const handleRefresh = () => {
    fetchProviders();
    fetchCommon();
  };

  const handleExport = async () => {
    try {
      const config = await exportConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cc-use-config-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success(t('配置导出成功', 'Config exported successfully', language));
    } catch {
      message.error(t('导出失败', 'Export failed', language));
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const config = JSON.parse(text) as Config;
        const result = await importConfig(config, false);
        message.success(
          t(
            `导入成功：${result.imported} 个，跳过：${result.skipped} 个`,
            `Imported: ${result.imported}, Skipped: ${result.skipped}`,
            language
          )
        );
        fetchProviders();
        fetchCommon();
      } catch {
        message.error(t('导入失败', 'Import failed, please check file format', language));
      }
    };
    input.click();
  };

  // Filter providers
  const filteredProviders = providers.filter((provider) => {
    const matchesSearch =
      !searchText ||
      provider.name.toLowerCase().includes(searchText.toLowerCase()) ||
      provider.description?.toLowerCase().includes(searchText.toLowerCase());
    const matchesType = filterType === 'all' || provider.type === filterType;
    return matchesSearch && matchesType;
  });

  return (
    <ConfigProvider theme={theme}>
      <div className="min-h-screen bg-slate-50" style={{ minWidth: 800 }}>
        <Header />

        <main className="px-8 py-6">
          {/* Top Bar: Type Tabs + Common Config (同级) */}
          <div className="flex items-center justify-between mb-6">
            <TypeTabs value={filterType} onChange={setFilterType} />

            <Button
              icon={<SettingOutlined />}
              onClick={() => setCommonDrawerOpen(true)}
              className="text-slate-600"
            >
              {t('通用配置', 'Common Config', language)}
            </Button>
          </div>

          {/* Toolbar: Search + Actions */}
          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 max-w-lg">
              <Input
                placeholder={t('搜索供应商...', 'Search providers...', language)}
                prefix={<SearchOutlined className="text-slate-400" />}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                allowClear
                size="large"
              />
            </div>

            <div className="flex items-center gap-1">
              <Tooltip title={t('刷新', 'Refresh', language)}>
                <Button
                  type="text"
                  icon={<ReloadOutlined spin={providersLoading} />}
                  onClick={handleRefresh}
                  className="text-slate-500 hover:text-primary"
                />
              </Tooltip>
              <Tooltip title={t('导入', 'Import', language)}>
                <Button
                  type="text"
                  icon={<ImportOutlined />}
                  onClick={handleImport}
                  className="text-slate-500 hover:text-primary"
                />
              </Tooltip>
              <Tooltip title={t('导出', 'Export', language)}>
                <Button
                  type="text"
                  icon={<ExportOutlined />}
                  onClick={handleExport}
                  className="text-slate-500 hover:text-primary"
                />
              </Tooltip>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => openDrawer()}
                className="ml-2 !bg-emerald-600 hover:!bg-emerald-700 !border-emerald-600"
              >
                {t('添加供应商', 'Add Provider', language)}
              </Button>
            </div>
          </div>

          {/* Provider Count */}
          <div className="mb-4 text-sm text-slate-500">
            {t('共', 'Total', language)} {filteredProviders.length} {t('个供应商', 'providers', language)}
          </div>

          {/* Provider Grid */}
          <ProviderGrid providers={filteredProviders} loading={providersLoading} />
        </main>

        <ProviderDrawer />
        <CommonDrawer />
        <AboutModal />
      </div>
    </ConfigProvider>
  );
}

export default App;
