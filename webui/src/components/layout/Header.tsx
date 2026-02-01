import { Button, Dropdown } from 'antd';
import { GlobalOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useUIStore, t } from '../../stores/ui';
import logoImg from '../../assets/icon.svg';

export default function Header() {
  const { language, setLanguage, setAboutOpen } = useUIStore();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="px-8">
        <div className="flex items-center justify-between h-14">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <img src={logoImg} alt="cc-use logo" className="w-8 h-8 rounded-lg" />
            <span className="text-lg font-semibold text-slate-800">cc-use</span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1">
            <Dropdown
              menu={{
                items: [
                  { key: 'zh', label: '中文' },
                  { key: 'en', label: 'English' },
                ],
                onClick: ({ key }) => setLanguage(key as 'zh' | 'en'),
              }}
            >
              <Button type="text" icon={<GlobalOutlined />} className="text-slate-500 hover:text-emerald-600">
                {language === 'zh' ? '中文' : 'EN'}
              </Button>
            </Dropdown>

            <Button
              type="text"
              icon={<InfoCircleOutlined />}
              onClick={() => setAboutOpen(true)}
              className="text-slate-500 hover:text-emerald-600"
            >
              {t('关于', 'About', language)}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
