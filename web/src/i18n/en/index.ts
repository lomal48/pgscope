// English dictionary: Russian source text -> English. One file per area so that
// translations can be edited independently; scripts/i18n-check.mjs validates them.
import core from './core.json'
import feCore from './fe-core.json'
import feTop from './fe-top.json'
import feOverviewActivity from './fe-overview-activity.json'
import feObjects from './fe-objects.json'
import feServerpages from './fe-serverpages.json'
import feAlerting from './fe-alerting.json'
import agents from './agents.json'
import docs from './docs.json'

export const en: Record<string, string> = { ...core, ...feCore, ...feTop, ...feOverviewActivity, ...feObjects, ...feServerpages, ...feAlerting, ...agents, ...docs }
