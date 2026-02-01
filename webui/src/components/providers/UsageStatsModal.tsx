import { Modal, Statistic, Row, Col, Empty, Spin } from 'antd';
import {
  DollarOutlined,
  HistoryOutlined,
  ThunderboltOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import type { Provider } from '../../api/client';
import { useUIStore, t } from '../../stores/ui';

interface UsageStatsModalProps {
  provider: Provider | null;
  onClose: () => void;
}

export default function UsageStatsModal({ provider, onClose }: UsageStatsModalProps) {
  const { language } = useUIStore();

  if (!provider) return null;

  const usageData = provider.usageData;
  const unit = usageData?.unit || 'USD';
  const prefix = unit === 'USD' ? '$' : '';
  const suffix = unit && unit !== 'USD' ? ` ${unit}` : '';

  const formatValue = (value: number | undefined) => {
    if (value === undefined) return '-';
    return `${prefix}${value.toFixed(2)}${suffix}`;
  };

  const hasData = usageData && !usageData.error;

  return (
    <Modal
      title={`${provider.name} - ${t('用量统计', 'Usage Statistics', language)}`}
      open={!!provider}
      onCancel={onClose}
      footer={null}
      width={600}
    >
      {!hasData ? (
        <Empty
          description={
            usageData?.error
              ? t('查询失败', 'Query failed', language)
              : t('暂无用量数据，请先配置用量查询', 'No usage data. Please configure usage query first.', language)
          }
        />
      ) : (
        <div className="py-4">
          <Row gutter={[24, 24]}>
            <Col span={12}>
              <Statistic
                title={
                  <span className="flex items-center gap-2">
                    <CalendarOutlined />
                    {t('今日用量', 'Today Usage', language)}
                  </span>
                }
                value={formatValue(usageData.todayUsed)}
                valueStyle={{ color: '#1890ff' }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title={
                  <span className="flex items-center gap-2">
                    <DollarOutlined />
                    {t('剩余用量', 'Remaining', language)}
                  </span>
                }
                value={formatValue(usageData.remaining)}
                valueStyle={{
                  color: usageData.remaining !== undefined && usageData.remaining <= 0
                    ? '#faad14'
                    : '#52c41a',
                }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title={
                  <span className="flex items-center gap-2">
                    <HistoryOutlined />
                    {t('历史用量', 'Total Used', language)}
                  </span>
                }
                value={formatValue(usageData.used)}
                valueStyle={{ color: '#722ed1' }}
              />
            </Col>
            <Col span={12}>
              <Statistic
                title={
                  <span className="flex items-center gap-2">
                    <ThunderboltOutlined />
                    {t('请求次数', 'Total Requests', language)}
                  </span>
                }
                value={usageData.requestCount?.toLocaleString() || '-'}
                valueStyle={{ color: '#13c2c2' }}
              />
            </Col>
          </Row>

          {usageData.total !== undefined && (
            <div className="mt-6 pt-4 border-t border-slate-100">
              <div className="text-sm text-slate-500 mb-2">
                {t('额度使用情况', 'Quota Usage', language)}
              </div>
              <div className="h-4 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 transition-all duration-500"
                  style={{
                    width: `${Math.min(100, ((usageData.remaining || 0) / usageData.total) * 100)}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>{t('已用', 'Used', language)}: {formatValue(usageData.used)}</span>
                <span>{t('总额', 'Total', language)}: {formatValue(usageData.total)}</span>
              </div>
            </div>
          )}

          {usageData.lastUpdated && (
            <div className="mt-4 text-xs text-slate-400 text-right">
              {t('最后更新', 'Last updated', language)}: {new Date(usageData.lastUpdated).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
