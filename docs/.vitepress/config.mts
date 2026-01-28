import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-Hant',
  title: 'MinIO 2024-05-07 知識庫',
  description: 'MinIO 原始碼分析與知識累積',
  base: '/MinIO_SourceCodeReading/',
  themeConfig: {
    nav: [
      { text: '首頁', link: '/' },
      { text: '讀碼計畫', link: '/reading-plan' },
      { text: '系統總覽', link: '/overview' },
      { text: '更新日誌', link: '/changelog' }
    ],
    sidebar: [
      { text: '開始', items: [
        { text: '首頁', link: '/' },
        { text: '讀碼計畫', link: '/reading-plan' },
        { text: '系統總覽', link: '/overview' },
        { text: '更新日誌', link: '/changelog' },
      ]}
    ]
  }
})
