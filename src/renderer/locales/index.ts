import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import zh from './zh'

// 默认中文，除非用户明确设置了其他语言
const getDefaultLanguage = () => {
  const saved = localStorage.getItem('language')
  if (saved) return saved
  return 'zh' // 默认中文
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: getDefaultLanguage(),
  fallbackLng: 'zh',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
