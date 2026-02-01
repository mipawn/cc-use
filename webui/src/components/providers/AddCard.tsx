import { PlusOutlined } from '@ant-design/icons';
import { useUIStore, t } from '../../stores/ui';

interface AddCardProps {
  onClick: () => void;
}

export default function AddCard({ onClick }: AddCardProps) {
  const { language } = useUIStore();

  return (
    <button
      onClick={onClick}
      className="
        flex flex-col items-center justify-center min-h-[200px]
        bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200
        hover:border-primary hover:bg-primary/5
        transition-all duration-200 cursor-pointer group
      "
    >
      <div className="w-12 h-12 rounded-xl bg-slate-100 group-hover:bg-primary/10 flex items-center justify-center mb-3 transition-all duration-200">
        <PlusOutlined className="text-xl text-slate-400 group-hover:text-primary transition-colors" />
      </div>
      <span className="text-sm font-medium text-slate-500 group-hover:text-primary transition-colors">
        {t('添加供应商', 'Add Provider', language)}
      </span>
    </button>
  );
}
