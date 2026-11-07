import { join } from 'node:path'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { parseAdultGroups, parseAdultLevel, type AdultLevel } from './content.js'
import { fallbackOf } from './envvars.js'

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

function secret(name: string): string {
  if (process.env[name] && process.env[`${name}_FILE`]) throw new Error(`Set only ${name} or ${name}_FILE`)
  const file = process.env[`${name}_FILE`]
  return file ? readFileSync(file, 'utf-8').replace(/\r?\n$/, '') : process.env[name] ?? ''
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10)
  return Number.isFinite(v) ? v : fallback
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (!v) return fallback
  return !['0', 'false', 'no', 'off'].includes(v)
}

/** Anything but a level is a mistake; the safe-for-work side is the safe reading of it. */
function adultGames(): '' | AdultLevel {
  const raw = process.env['RENPLAY_ADULT_GAMES']?.trim()
  if (!raw) return ''
  const level = parseAdultLevel(raw, true)
  if (level) return level
  console.warn(`config: RENPLAY_ADULT_GAMES=${raw} is not off, blurred or shown. Adult games are off.`)
  return 'off'
}

function adultDefault(): AdultLevel {
  const raw = process.env['RENPLAY_ADULT_DEFAULT']?.trim()
  if (!raw) return 'off'
  const level = parseAdultLevel(raw, true)
  if (level) return level
  console.warn(`config: RENPLAY_ADULT_DEFAULT=${raw} is not off, blurred or shown. New people start with adult games off.`)
  return 'off'
}

/** group=level lists from the sign-in providers. The 3.x single group stays as an alias. */
function adultGroups(raw: string, variable: string, alias: string, aliasVariable: string): { map: Record<string, AdultLevel>; variable: string } | null {
  if (raw) {
    // A mapping with no valid entry still means the groups decide: nobody matches, so everyone is
    // at Off until it is fixed. Reading a typo as no mapping would leave hand settings in force.
    const map = parseAdultGroups(raw, variable) ?? {}
    if (!Object.keys(map).length) console.error(`config: ${variable} has no valid group=off, =blurred or =shown entry. Everyone who signs in through it gets adult games off.`)
    return { map, variable }
  }
  if (alias) {
    console.warn(`config: ${aliasVariable} is a 3.x alias of ${variable}. It means ${alias}=shown and everyone else off.`)
    return { map: { [alias]: 'shown' }, variable: aliasVariable }
  }
  return null
}

/** Only select an existing writable downloads mount. Never create it or move files. */
export function downloadsDirectory(gamesDir: string, downloads = '/downloads'): string {
  try {
    if (statSync(downloads).isDirectory()) {
      accessSync(downloads, constants.W_OK)
      return downloads
    }
  } catch { /* No usable optional mount. Keep the legacy folder. */ }
  return join(gamesDir, '_archives')
}

let warnedDeleteArchives = false

export interface Config {
  auth: '' | 'on' | 'off'
  authUser: number
  authLocal: boolean
  oidcIssuer: string
  oidcClientId: string
  oidcClientSecret: string
  oidcName: string
  oidcAutoCreate: boolean
  oidcAdminGroup: string
  /** group=level ceilings matched on the groups claim exactly; null when no mapping is configured. */
  oidcAdultGroups: Record<string, AdultLevel> | null
  /** Which variable oidcAdultGroups came from: RENPLAY_OIDC_ADULT_GROUPS or its 3.x alias. */
  oidcAdultGroupsVariable: string
  admins: string[]
  ldapUrl: string
  ldapBindDn: string
  ldapBindPassword: string
  ldapBaseDn: string
  ldapUserFilter: string
  ldapUsernameAttribute: string
  ldapNameAttribute: string
  ldapEmailAttribute: string
  ldapPhotoAttribute: string
  ldapAdminFilter: string
  ldapAdultFilter: string
  /** group=level ceilings from RENPLAY_LDAP_ADULT_GROUPS, matched on memberOf cn, case-insensitive. */
  ldapAdultGroups: Record<string, AdultLevel> | null
  ldapStartTls: boolean
  ldapCaFile: string
  adminUsername: string
  adminPassword: string
  publicUrl: string
  trustedHops: number
  /** Ceiling and starting choice for new people. */
  adultDefault: AdultLevel
  port: number
  dataDir: string
  savesDir: string
  saveHistoryDir: string
  coversDir: string
  walkthroughsDir: string
  overlaysDir: string
  /** Installed games: <gamesDir>/<id>/<build>/. */
  gamesDir: string
  /** renplay internals on the games volume: engines, work, purge, uploads. */
  internalDir: string
  /** Original game archives (zip/7z/rar): drop folder and reinstall source. */
  archivesDir: string
  /** Keep downloads unless an admin opts into upload cleanup. */
  keepDownloads: boolean
  keepDownloadsLocked: boolean
  enginesDir: string
  workDir: string
  purgeDir: string
  uploadsDir: string
  enginesUrl: string
  catalogUrls: string[]
  /** RENPLAY_ADULT_GAMES: a level fixes the installation; empty leaves it to the stored setting (content.ts). */
  adultGames: '' | AdultLevel
  /** Pin every build to this engine version instead of the latest 8.x. */
  defaultEngine: string
  /** Optional URL that routes back to this pod through the scale-to-zero proxy. */
  keepaliveUrl: string
  keepaliveHost: string
  imageQuality: number
  imageConcurrency: number
  saveHistoryVersions: number
  /** Where the daily save backup goes, or null when backups are off. */
  backupDir: string | null
  backupKeep: number
  /** Your recipes: a folder of recipe files read as one more catalog. */
  recipesDir: string
  /** Ren'Py's sync server, for Sync codes. */
  syncServer: string
}

export function loadConfig(): Config {
  const dataDir = env('DATA_DIR', fallbackOf('DATA_DIR'))
  const gamesDir = env('GAMES_DIR', fallbackOf('GAMES_DIR'))
  const internalDir = env('RENPLAY_DIR', join(gamesDir, '_renplay'))
  const legacyDownloads = !!process.env['RENPLAY_DELETE_ARCHIVES']?.trim()
  const keepDownloadsLocked = !!process.env['RENPLAY_KEEP_DOWNLOADS']?.trim() || legacyDownloads
  if (legacyDownloads && !warnedDeleteArchives) {
    console.warn('config: RENPLAY_DELETE_ARCHIVES is deprecated. Use RENPLAY_KEEP_DOWNLOADS with the opposite value. RENPLAY_KEEP_DOWNLOADS takes precedence.')
    warnedDeleteArchives = true
  }
  const keepDownloads = process.env['RENPLAY_KEEP_DOWNLOADS']?.trim()
    ? envBool('RENPLAY_KEEP_DOWNLOADS', true)
    : legacyDownloads ? !envBool('RENPLAY_DELETE_ARCHIVES', false) : true
  const auth = env('RENPLAY_AUTH', '')
  if (auth && auth !== 'on' && auth !== 'off') throw new Error('RENPLAY_AUTH must be on or off')
  if (process.env['RENPLAY_LDAP_ADULT_GROUPS']?.trim() && process.env['RENPLAY_LDAP_ADULT_FILTER']?.trim())
    console.warn('config: RENPLAY_LDAP_ADULT_GROUPS is set, so the RENPLAY_LDAP_ADULT_FILTER alias is ignored.')
  const oidcGroups = adultGroups(env('RENPLAY_OIDC_ADULT_GROUPS', ''), 'RENPLAY_OIDC_ADULT_GROUPS', env('RENPLAY_OIDC_ADULT_GROUP', ''), 'RENPLAY_OIDC_ADULT_GROUP')
  const ldapGroups = adultGroups(env('RENPLAY_LDAP_ADULT_GROUPS', ''), 'RENPLAY_LDAP_ADULT_GROUPS', '', '')
  return {
    auth: auth as '' | 'on' | 'off',
    authUser: envInt('RENPLAY_AUTH_USER', 1),
    authLocal: envBool('RENPLAY_AUTH_LOCAL', true),
    oidcIssuer: env('RENPLAY_OIDC_ISSUER', ''),
    oidcClientId: env('RENPLAY_OIDC_CLIENT_ID', ''),
    oidcClientSecret: secret('RENPLAY_OIDC_CLIENT_SECRET'),
    oidcName: env('RENPLAY_OIDC_NAME', 'Single sign-on'),
    oidcAutoCreate: envBool('RENPLAY_OIDC_AUTO_CREATE', true),
    oidcAdminGroup: env('RENPLAY_OIDC_ADMIN_GROUP', ''),
    oidcAdultGroups: oidcGroups?.map ?? null,
    oidcAdultGroupsVariable: oidcGroups?.variable ?? '',
    admins: env('RENPLAY_ADMINS', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    ldapUrl: env('RENPLAY_LDAP_URL', ''),
    ldapBindDn: env('RENPLAY_LDAP_BIND_DN', ''),
    ldapBindPassword: secret('RENPLAY_LDAP_BIND_PASSWORD'),
    ldapBaseDn: env('RENPLAY_LDAP_BASE_DN', ''),
    ldapUserFilter: env('RENPLAY_LDAP_USER_FILTER', '(&(objectClass=person)(uid={username}))'),
    ldapUsernameAttribute: env('RENPLAY_LDAP_USERNAME_ATTRIBUTE', 'uid'),
    ldapNameAttribute: env('RENPLAY_LDAP_NAME_ATTRIBUTE', 'displayName'),
    ldapEmailAttribute: env('RENPLAY_LDAP_EMAIL_ATTRIBUTE', 'mail'),
    ldapPhotoAttribute: env('RENPLAY_LDAP_PHOTO_ATTRIBUTE', 'jpegPhoto'),
    ldapAdminFilter: env('RENPLAY_LDAP_ADMIN_FILTER', ''),
    ldapAdultFilter: env('RENPLAY_LDAP_ADULT_FILTER', ''),
    ldapAdultGroups: ldapGroups?.map ?? null,
    ldapStartTls: envBool('RENPLAY_LDAP_STARTTLS', false),
    ldapCaFile: env('RENPLAY_LDAP_CA_FILE', ''),
    adminUsername: env('RENPLAY_ADMIN_USERNAME', ''),
    adminPassword: secret('RENPLAY_ADMIN_PASSWORD'),
    publicUrl: env('RENPLAY_PUBLIC_URL', ''),
    trustedHops: Math.max(0, envInt('RENPLAY_TRUSTED_HOPS', 1)),
    adultDefault: adultDefault(),
    port: envInt('PORT', fallbackOf('PORT')),
    dataDir,
    savesDir: env('SAVES_DIR', join(dataDir, 'saves')),
    saveHistoryDir: env('SAVE_HISTORY_DIR', join(dataDir, 'save-history')),
    coversDir: join(dataDir, 'covers'),
    walkthroughsDir: join(dataDir, 'walkthroughs'),
    overlaysDir: env('OVERLAYS_DIR', join(dataDir, 'overlays')),
    gamesDir,
    internalDir,
    archivesDir: env('ARCHIVES_DIR', downloadsDirectory(gamesDir)),
    keepDownloads,
    keepDownloadsLocked,
    enginesDir: join(internalDir, 'engines'),
    workDir: join(internalDir, 'work'),
    purgeDir: join(internalDir, 'purge'),
    uploadsDir: join(internalDir, 'uploads'),
    enginesUrl: env('RENPLAY_ENGINES_URL', fallbackOf('RENPLAY_ENGINES_URL')),
    catalogUrls: env('RENPLAY_CATALOG_URLS', fallbackOf('RENPLAY_CATALOG_URLS'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adultGames: adultGames(),
    defaultEngine: env('RENPLAY_ENGINE', fallbackOf('RENPLAY_ENGINE')),
    keepaliveUrl: env('RENPLAY_KEEPALIVE_URL', fallbackOf('RENPLAY_KEEPALIVE_URL')),
    keepaliveHost: env('RENPLAY_KEEPALIVE_HOST', fallbackOf('RENPLAY_KEEPALIVE_HOST')),
    imageQuality: envInt('RENPLAY_IMAGE_QUALITY', fallbackOf('RENPLAY_IMAGE_QUALITY')),
    imageConcurrency: envInt('RENPLAY_IMAGE_CONCURRENCY', fallbackOf('RENPLAY_IMAGE_CONCURRENCY')),
    saveHistoryVersions: envInt('RENPLAY_SAVE_HISTORY', fallbackOf('RENPLAY_SAVE_HISTORY')),
    backupDir: (() => {
      const raw = env('RENPLAY_BACKUP_DIR', '').trim()
      if (raw.toLowerCase() === 'off') return null
      return raw || join(dataDir, 'backups', 'saves')
    })(),
    backupKeep: Math.max(1, envInt('RENPLAY_BACKUP_KEEP', fallbackOf('RENPLAY_BACKUP_KEEP'))),
    recipesDir: env('RENPLAY_RECIPES_DIR', '') || join(dataDir, 'recipes'),
    syncServer: env('RENPLAY_SYNC_SERVER', fallbackOf('RENPLAY_SYNC_SERVER')).replace(/\/+$/, ''),
  }
}
