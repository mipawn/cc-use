import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Popconfirm, Tooltip, message } from 'antd';
import {
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  LinkOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import type { Provider } from '../../api/client';
import { useProvidersStore } from '../../stores/providers';
import { useUIStore, t } from '../../stores/ui';
import claudeIcon from '../../assets/claude-icon.svg';
import codexIcon from '../../assets/codex-icon.svg';

interface ProviderCardProps {
  provider: Provider;
  isDragging?: boolean;
  isOverlay?: boolean;
  onShowStats?: (provider: Provider) => void;
}

export default function ProviderCard({ provider, isDragging, isOverlay, onShowStats }: ProviderCardProps) {
  const { deleteProvider, duplicateProvider } = useProvidersStore();
  const { language, openDrawer } = useUIStore();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: provider.id, disabled: isOverlay });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease',
  };

  const handleDelete = async () => {
    try {
      await deleteProvider(provider.id);
      message.success(t('删除成功', 'Deleted successfully', language));
    } catch {
      message.error(t('删除失败', 'Delete failed', language));
    }
  };

  const handleDuplicate = async () => {
    const newName = `${provider.name}-copy`;
    try {
      await duplicateProvider(provider.id, newName);
      message.success(t('复制成功', 'Duplicated successfully', language));
    } catch {
      message.error(t('复制失败', 'Duplicate failed', language));
    }
  };

  const isClaudeType = provider.type === 'claude';
  const typeIcon = isClaudeType ? claudeIcon : codexIcon;

  const unit = provider.usageData?.unit || 'USD';
  const used = provider.usageData?.used;
  const remaining = provider.usageData?.remaining;
  const requestCount = provider.usageData?.requestCount;
  const todayUsed = provider.usageData?.todayUsed;
  const isZeroRemaining = remaining !== undefined && remaining <= 0;

  const formatValue = (value: number | undefined) => {
    if (value === undefined) return t('无数据', 'N/A', language);
    const prefix = unit === 'USD' ? '$' : '';
    const suffix = unit && unit !== 'USD' ? ` ${unit}` : '';
    return `${prefix}${value.toFixed(2)}${suffix}`;
  };

  const providerUrl = provider.websiteUrl;
  const displayName = provider.name.replace(/\s/g, '').slice(0, 20);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        bg-white rounded-2xl border p-5
        transition-all duration-200 ease-out
        ${isZeroRemaining ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}
        ${isDragging ? 'opacity-40 scale-[0.98] shadow-lg ring-2 ring-emerald-500/30' : 'hover:shadow-lg hover:-translate-y-1'}
        ${isOverlay ? 'shadow-2xl' : ''}
      `}
    >
      {/* Header: Name + Drag Handle + Type Icon */}
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-lg font-semibold text-slate-800 truncate flex-1">
          {displayName}
        </h3>
        <button
          {...attributes}
          {...listeners}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-100 cursor-grab active:cursor-grabbing transition-all flex-shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <circle cx="4" cy="3" r="1.5" />
            <circle cx="10" cy="3" r="1.5" />
            <circle cx="4" cy="7" r="1.5" />
            <circle cx="10" cy="7" r="1.5" />
            <circle cx="4" cy="11" r="1.5" />
            <circle cx="10" cy="11" r="1.5" />
          </svg>
        </button>
        <Tooltip title={isClaudeType ? 'Claude' : 'Codex'}>
          <img
            src={typeIcon}
            alt={provider.type}
            className="w-6 h-6 flex-shrink-0"
          />
        </Tooltip>
      </div>

      {/* Description - max 2 lines */}
      <p className="text-sm text-slate-500 line-clamp-2 leading-relaxed mb-4">
        {provider.description || t('暂无描述', 'No description', language)}
      </p>

      {/* Usage Info - Always show */}
      <div className="space-y-1.5 mb-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">{t('今日用量', 'Today', language)}</span>
          <span className="font-medium text-slate-600">{formatValue(todayUsed)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">{t('剩余用量', 'Remaining', language)}</span>
          <span className={`font-semibold ${isZeroRemaining ? 'text-amber-500' : remaining !== undefined ? 'text-emerald-600' : 'text-slate-400'}`}>
            {formatValue(remaining)}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">{t('请求次数', 'Requests', language)}</span>
          <span className="font-medium text-slate-600">
            {requestCount !== undefined ? requestCount.toLocaleString() : t('无数据', 'N/A', language)}
          </span>
        </div>
      </div>

      {/* Provider Link */}
      <div className="mb-4">
        {providerUrl ? (
          <a
            href={providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 transition-colors"
          >
            <LinkOutlined />
            <span>{t('官网', 'Website', language)}</span>
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-slate-400">
            <LinkOutlined />
            <span>{t('暂无官网', 'No website', language)}</span>
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 pt-4 border-t border-slate-100">
        <Tooltip title={t('编辑', 'Edit', language)}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => openDrawer(provider.id)}
            className="text-slate-400 hover:text-primary"
          />
        </Tooltip>
        <Tooltip title={t('用量统计', 'Usage Stats', language)}>
          <Button
            type="text"
            size="small"
            icon={<BarChartOutlined />}
            onClick={() => onShowStats?.(provider)}
            className="text-slate-400 hover:text-primary"
          />
        </Tooltip>
        <Tooltip title={t('复制', 'Duplicate', language)}>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={handleDuplicate}
            className="text-slate-400 hover:text-primary"
          />
        </Tooltip>
        <div className="flex-1" />
        <Popconfirm
          title={t('确定删除？', 'Are you sure?', language)}
          onConfirm={handleDelete}
          okText={t('确定', 'Yes', language)}
          cancelText={t('取消', 'No', language)}
        >
          <Tooltip title={t('删除', 'Delete', language)}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              className="text-slate-400 hover:text-red-500"
            />
          </Tooltip>
        </Popconfirm>
      </div>
    </div>
  );
}
