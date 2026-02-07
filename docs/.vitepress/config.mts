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
      { text: '系統總覽', link: '/architecture/overview' },
      { text: '更新日誌', link: '/changelog' }
    ],
    sidebar: [
      {
        text: '導覽',
        items: [
          { text: '首頁', link: '/' },
          { text: '讀碼計畫', link: '/reading-plan' },
          { text: '更新日誌', link: '/changelog' }
        ]
      },
      {
        text: '架構',
        items: [
          { text: '總覽', link: '/architecture/overview' },
          { text: '啟動流程', link: '/architecture/startup' },
          { text: 'HTTP Routing', link: '/architecture/http-routing' },
          { text: 'ObjectLayer', link: '/architecture/object-layer' },
          { text: 'Erasure', link: '/architecture/erasure' },
          { text: 'IAM', link: '/architecture/iam' }
        ]
      },
      {
        text: 'Trace（路徑追蹤）',
        items: [
          { text: 'PutObject', link: '/trace/putobject' },
          { text: 'Healing', link: '/trace/healing' },
          { text: 'PutObject vs Healing', link: '/trace/putobject-healing' },
          { text: 'Admin Heal', link: '/trace/admin-heal' }
        ]
      },

      {
        text: 'Troubleshooting',
        items: [
          { text: 'canceling remote connection', link: '/troubleshooting/canceling-remote-connection' }
        ]
      }
    ]
  }
})
