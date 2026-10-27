import { tk } from '../lib/i18n'

// Documentation pages live in ./<lang>/<slug>.md. Each page has one "# Title" and
// "## Heading {#anchor}" sections whose anchors are the same in every language, so
// links (#/docs/<slug>/<anchor>) survive a language switch. scripts/i18n-check.mjs
// validates files, anchors and links.
export const DOC_GROUPS: [string, string[]][] = [
  [tk('Начало работы'), ['intro', 'quickstart', 'install', 'config']],
  [tk('Сбор данных'), ['postgres', 'collect', 'docker']],
  [tk('Работа в интерфейсе'), ['ui', 'fleet', 'monitoring', 'activity', 'objects', 'server', 'integrations']],
  [tk('Оповещения'), ['alerts', 'notifications', 'change-alerts']],
  [tk('Администрирование'), ['teams', 'data', 'security']],
  [tk('Справочник'), ['checks', 'api', 'scenarios', 'troubleshooting']],
]
