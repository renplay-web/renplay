/**
 * Every environment variable Renplay reads, in one table. config.ts reads its defaults from here,
 * and docs/site/scripts/gen-config.mjs writes the configuration page of the docs from it. Keep
 * the descriptions short, in plain words for the person running the server. Only erasable
 * TypeScript here: the docs script loads this file with Node directly.
 */
export interface EnvVar {
  name: string
  group: 'Folders' | 'Games and catalog' | 'Images and saves' | 'Behind a proxy' | 'Server'
  kind: 'text' | 'number' | 'yes/no' | 'choice'
  /** The value used when the variable is unset or empty. */
  fallback: string | number | boolean
  /** What the page shows as the default when it is worked out from other variables. */
  shown?: string
  description: string
}

export const ENV_VARS: readonly EnvVar[] = [
  { name: 'PUID', group: 'Server', kind: 'number', fallback: 1000, description: 'Container only: when started as root, drop to this non-root user ID before starting Renplay. Ignored when started with --user. Make the mounted folders writable by this user; Renplay does not change their ownership.' },
  { name: 'PGID', group: 'Server', kind: 'number', fallback: 1000, description: 'Container only: group ID to use with PUID when started as root. Ignored when started with --user.' },
  { name: 'RENPLAY_OIDC_ISSUER', group: 'Server', kind: 'text', fallback: '', description: 'OIDC issuer URL. Enables discovery and single sign-on. Requires HTTPS, except loopback test servers.' },
  { name: 'RENPLAY_OIDC_CLIENT_ID', group: 'Server', kind: 'text', fallback: '', description: 'OIDC client id. Register /api/auth/oidc/callback on RENPLAY_PUBLIC_URL as the callback URL.' },
  { name: 'RENPLAY_OIDC_CLIENT_SECRET', group: 'Server', kind: 'text', fallback: '', description: 'OIDC client secret. Prefer the _FILE variant. Empty supports public clients with PKCE.' },
  { name: 'RENPLAY_OIDC_CLIENT_SECRET_FILE', group: 'Server', kind: 'text', fallback: '', description: 'Read the OIDC client secret from this file. Set this or RENPLAY_OIDC_CLIENT_SECRET, not both.' },
  { name: 'RENPLAY_OIDC_NAME', group: 'Server', kind: 'text', fallback: 'Single sign-on', description: 'Name on the sign-in and account buttons.' },
  { name: 'RENPLAY_OIDC_AUTO_CREATE', group: 'Server', kind: 'yes/no', fallback: true, description: 'Create accounts at first OIDC sign-in. If false, people must explicitly link their identity while signed in first.' },
  { name: 'RENPLAY_OIDC_ADMIN_GROUP', group: 'Server', kind: 'text', fallback: '', description: 'Exact groups claim value granting Admin. Provider grants follow membership at each OIDC sign-in, even for the last admin. Admin access assigned in Users is kept.' },
  { name: 'RENPLAY_OIDC_ADULT_GROUP', group: 'Server', kind: 'text', fallback: '', description: 'Deprecated alias of RENPLAY_OIDC_ADULT_GROUPS: the group gets shown, everyone else off. Still supported, with a warning once at startup. RENPLAY_OIDC_ADULT_GROUPS takes precedence when both are set.' },
  { name: 'RENPLAY_OIDC_ADULT_GROUPS', group: 'Server', kind: 'text', fallback: '', description: 'Adult games ceilings by sign-in group: group=off, =blurred or =shown, separated by commas. Matches the groups claim exactly. When set, a person’s ceiling is the highest level of their groups, or off when none match, recomputed at each OIDC sign-in, and Users cannot change it.' },
  { name: 'RENPLAY_ADMINS', group: 'Server', kind: 'text', fallback: '', description: 'Comma-separated provider usernames or verified OIDC emails granted Admin when no admin group/filter is configured. Grants are checked at each sign-in and removed on unlink. Admin access assigned in Users is kept. LDAP email is not treated as verified.' },
  { name: 'RENPLAY_LDAP_URL', group: 'Server', kind: 'text', fallback: '', description: 'LDAP directory URL, ldap:// or ldaps://. Prefer TLS. Enables directory password sign-in.' },
  { name: 'RENPLAY_LDAP_BIND_DN', group: 'Server', kind: 'text', fallback: '', description: 'Directory service account DN used to search for users and check groups.' },
  { name: 'RENPLAY_LDAP_BIND_PASSWORD', group: 'Server', kind: 'text', fallback: '', description: 'Directory service account password. Prefer the _FILE variant.' },
  { name: 'RENPLAY_LDAP_BIND_PASSWORD_FILE', group: 'Server', kind: 'text', fallback: '', description: 'Read the LDAP bind password from this file. Set this or RENPLAY_LDAP_BIND_PASSWORD, not both.' },
  { name: 'RENPLAY_LDAP_BASE_DN', group: 'Server', kind: 'text', fallback: '', description: 'Base DN under which user entries are searched.' },
  { name: 'RENPLAY_LDAP_USER_FILTER', group: 'Server', kind: 'text', fallback: '(&(objectClass=person)(uid={username}))', description: 'User search filter. Every {username} is escaped before substitution. Exactly one entry must match.' },
  { name: 'RENPLAY_LDAP_USERNAME_ATTRIBUTE', group: 'Server', kind: 'text', fallback: 'uid', description: 'Directory attribute for the username.' },
  { name: 'RENPLAY_LDAP_NAME_ATTRIBUTE', group: 'Server', kind: 'text', fallback: 'displayName', description: 'Directory display-name attribute; falls back to cn, then username.' },
  { name: 'RENPLAY_LDAP_EMAIL_ATTRIBUTE', group: 'Server', kind: 'text', fallback: 'mail', description: 'Directory email attribute. LDAP email never grants admin access through RENPLAY_ADMINS.' },
  { name: 'RENPLAY_LDAP_PHOTO_ATTRIBUTE', group: 'Server', kind: 'text', fallback: 'jpegPhoto', description: 'Directory binary photo attribute, copied locally at sign-in.' },
  { name: 'RENPLAY_LDAP_ADMIN_FILTER', group: 'Server', kind: 'text', fallback: '', description: 'Filter evaluated against the authenticated user entry, such as memberOf=cn=renplay-admins,ou=groups,dc=example,dc=org. Provider grants follow membership at each LDAP sign-in, even for the last admin. Admin access assigned in Users is kept.' },
  { name: 'RENPLAY_LDAP_ADULT_FILTER', group: 'Server', kind: 'text', fallback: '', description: 'Deprecated alias of RENPLAY_LDAP_ADULT_GROUPS: a matching entry gets shown, everyone else off. Filter evaluated against the authenticated user entry at each LDAP sign-in. RENPLAY_LDAP_ADULT_GROUPS takes precedence when both are set.' },
  { name: 'RENPLAY_LDAP_ADULT_GROUPS', group: 'Server', kind: 'text', fallback: '', description: 'Adult games ceilings by directory group: group=off, =blurred or =shown, separated by commas. Matches the cn of the user’s memberOf groups, case-insensitive. When set, the ceiling is the highest level of their groups, or off when none match, recomputed at each LDAP sign-in, and Users cannot change it.' },
  { name: 'RENPLAY_LDAP_STARTTLS', group: 'Server', kind: 'yes/no', fallback: false, description: 'Require StartTLS before sending any credentials over ldap://. A failed TLS upgrade refuses sign-in.' },
  { name: 'RENPLAY_LDAP_CA_FILE', group: 'Server', kind: 'text', fallback: '', description: 'PEM CA certificate file for directory TLS. Certificate verification is always enabled.' },
  { name: 'RENPLAY_AUTH', group: 'Server', kind: 'choice', fallback: '', shown: 'on for new installs, off after an upgrade', description: '`on` requires sign-in. `off` lets everyone play as one account. Saves always stay separate per account. Upgraded installs show an admin reminder while sign-in is off.' },
  { name: 'RENPLAY_AUTH_USER', group: 'Server', kind: 'number', fallback: 1, description: 'Account id used without sign-in. The owner is 1; other accounts and their saves stay untouched.' },
  { name: 'RENPLAY_AUTH_LOCAL', group: 'Server', kind: 'yes/no', fallback: true, description: 'Enable username and password sign-in. With sign-in on, disabling the only provider refuses startup.' },
  { name: 'RENPLAY_ADMIN_USERNAME', group: 'Server', kind: 'text', fallback: '', shown: 'not set', description: 'Claim the owner account at first start with this username and RENPLAY_ADMIN_PASSWORD. Otherwise use the setup code printed in the server log.' },
  { name: 'RENPLAY_ADMIN_PASSWORD', group: 'Server', kind: 'text', fallback: '', shown: 'not set', description: 'Initial owner password (at least 10 characters). Only used while the owner is unclaimed. Prefer RENPLAY_ADMIN_PASSWORD_FILE.' },
  { name: 'RENPLAY_ADMIN_PASSWORD_FILE', group: 'Server', kind: 'text', fallback: '', shown: 'not set', description: 'Read the initial owner password from this secret file. Set this or RENPLAY_ADMIN_PASSWORD, not both.' },
  { name: 'RENPLAY_PUBLIC_URL', group: 'Behind a proxy', kind: 'text', fallback: '', shown: 'not set', description: 'Public address, such as https://play.example.org. Used to check request origins and secure cookies. Plain HTTP works too, but HTTPS protects passwords and saves in transit.' },
  { name: 'RENPLAY_TRUSTED_HOPS', group: 'Behind a proxy', kind: 'number', fallback: 1, description: 'Trusted proxy hops for client addresses and HTTPS detection. The included nginx is one hop. Use 0 when exposing Node directly; never trust arbitrary forwarded headers.' },
  { name: 'RENPLAY_ADULT_DEFAULT', group: 'Games and catalog', kind: 'choice', fallback: 'off', description: 'Ceiling and starting choice of adult games for newly created accounts: off, blurred or shown (allow and block work as before). The first admin always starts at shown. Admins can change the ceiling per account in Users.' },
  {
    name: 'PORT',
    group: 'Server',
    kind: 'number',
    fallback: 3000,
    description:
      'Port of the Renplay server inside the container. nginx listens on 8080 and forwards to it, so you rarely change this.',
  },
  {
    name: 'GAMES_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '/games',
    description: 'Where installed games live. Put this on a big disk.',
  },
  {
    name: 'DATA_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '/data',
    description: 'Saves and their history, the library database, mods, covers and walkthroughs. Use a local disk, never a network share: SQLite needs local filesystem locking. Back this up.',
  },
  {
    name: 'ARCHIVES_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '',
    shown: '`/downloads` if it exists and is writable, otherwise `$GAMES_DIR/_archives`',
    description: 'Downloads and the drop folder (zip, 7z, rar), kept for reinstalls. An explicit path overrides automatic detection. Existing files are never moved.',
  },
  {
    name: 'RENPLAY_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '',
    shown: '`$GAMES_DIR/_renplay`',
    description: 'Engines and scratch space. Keep it on the same filesystem as `GAMES_DIR`.',
  },
  {
    name: 'SAVES_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '',
    shown: '`$DATA_DIR/saves`',
    description: 'Where saves are stored, laid out like desktop Ren’Py does.',
  },
  {
    name: 'SAVE_HISTORY_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '',
    shown: '`$DATA_DIR/save-history`',
    description: 'Earlier versions of saves that were overwritten or deleted.',
  },
  {
    name: 'OVERLAYS_DIR',
    group: 'Folders',
    kind: 'text',
    fallback: '',
    shown: '`$DATA_DIR/overlays`',
    description: 'Mods: your files, layered over a game.',
  },
  {
    name: 'RENPLAY_KEEP_DOWNLOADS',
    group: 'Games and catalog',
    kind: 'yes/no',
    fallback: true,
    description: 'Keep downloads after install so games can be reinstalled. `false` deletes only unchanged uploads through Renplay after a successful install. Files copied in are never deleted automatically. Setting this variable locks the Settings switch. When unset, admins can choose in Settings.',
  },
  {
    name: 'RENPLAY_DELETE_ARCHIVES',
    group: 'Games and catalog',
    kind: 'yes/no',
    fallback: false,
    shown: 'not set',
    description: 'Deprecated alias for the opposite of `RENPLAY_KEEP_DOWNLOADS`. `true` deletes uploaded downloads and `false` keeps them. Still supported in 3.x, with a warning once at startup. `RENPLAY_KEEP_DOWNLOADS` takes precedence when both are set.',
  },
  {
    name: 'RENPLAY_ADULT_GAMES',
    group: 'Games and catalog',
    kind: 'choice',
    fallback: '',
    shown: 'not set',
    description:
      'The installation level of adult games: off (they do not exist), blurred (they show with hidden art) or shown, and the choice is fixed. The 3.x spellings work too: allow is shown, block is off. Not set: the stored choice applies (shown until an install answers its first-run question), and admins can change it in Settings. At off the server reads the catalog’s safe-for-work index. Below shown it never downloads adult art. Any other value counts as off.',
  },
  {
    name: 'RENPLAY_CATALOG_URLS',
    group: 'Games and catalog',
    kind: 'text',
    fallback: 'https://catalog.renplay.org/index.v4.json',
    description: 'Catalog indexes, separated by commas. The first one that defines a tag wins. Schema 4 indexes give each game its pictures in five formats. A schema 3 index still works, its cover becoming the grid.',
  },
  {
    name: 'RENPLAY_ENGINES_URL',
    group: 'Games and catalog',
    kind: 'text',
    fallback: 'https://engines.renplay.org/index.json',
    description: 'Where the Ren’Py web engines come from.',
  },
  {
    name: 'RENPLAY_ENGINE',
    group: 'Games and catalog',
    kind: 'text',
    fallback: '',
    shown: 'newest for the game',
    description: 'Build every game with this one engine version, such as one the engines index lists. A game’s recipe still wins.',
  },
  {
    name: 'RENPLAY_IMAGE_QUALITY',
    group: 'Images and saves',
    kind: 'number',
    fallback: 88,
    description: 'WebP quality (1 to 100) for converted images.',
  },
  {
    name: 'RENPLAY_IMAGE_CONCURRENCY',
    group: 'Images and saves',
    kind: 'number',
    fallback: 0,
    shown: 'CPU count (at most 16)',
    description: 'Images converted in parallel during an install. `0` picks the CPU count.',
  },
  {
    name: 'RENPLAY_LOG_LEVEL',
    group: 'Server',
    kind: 'choice',
    fallback: 'info',
    description: 'How much the server logs. `error`: errors only. `warn`: also warnings and requests that failed on the server. `info`: also the start summary, installs, catalog updates, backups, sign-ins, and requests that change something or fail. `debug`: every request and each install as it runs.',
  },
  {
    name: 'RENPLAY_RECIPES_DIR',
    group: 'Games and catalog',
    kind: 'text',
    fallback: '',
    shown: 'recipes in the data folder',
    description: 'Your recipes: a folder of recipe files in the catalog’s format, read as one more catalog. A recipe here takes the place of a catalog recipe with the same id.',
  },
  {
    name: 'RENPLAY_SAVE_HISTORY',
    group: 'Images and saves',
    kind: 'number',
    fallback: 20,
    description: 'Earlier versions kept per save file.',
  },
  {
    name: 'RENPLAY_BACKUP_DIR',
    group: 'Images and saves',
    kind: 'text',
    fallback: '',
    shown: 'backups/saves in the data folder',
    description: 'Where a daily zip of everyone’s saves goes. Point it at another disk or a share to keep a copy apart from the data folder. `off` turns save backups off. A server that sleeps when idle makes the backup the next time it runs.',
  },
  {
    name: 'RENPLAY_SYNC_SERVER',
    group: 'Images and saves',
    kind: 'text',
    fallback: 'https://sync.renpy.org',
    description: 'The Ren’Py sync server for Sync codes, which an admin turns on in Settings. Change it only to use your own server that speaks the same protocol.',
  },
  {
    name: 'RENPLAY_BACKUP_KEEP',
    group: 'Images and saves',
    kind: 'number',
    fallback: 14,
    description: 'Save backups kept. Older ones are deleted.',
  },
  {
    name: 'RENPLAY_KEEPALIVE_URL',
    group: 'Behind a proxy',
    kind: 'text',
    fallback: '',
    shown: 'not set',
    description:
      'For scale-to-zero setups: a public URL that routes back to this server. While an install runs, Renplay keeps requesting it so the proxy does not stop the server.',
  },
  {
    name: 'RENPLAY_KEEPALIVE_HOST',
    group: 'Behind a proxy',
    kind: 'text',
    fallback: '',
    shown: 'not set',
    description: 'The `Host` header to send with the keep-alive requests, if the proxy routes by host name.',
  },
]

const byName = new Map(ENV_VARS.map((v) => [v.name, v]))

/** The default of a variable from the table. */
export function fallbackOf<T extends string | number | boolean>(name: string): T {
  const v = byName.get(name)
  if (!v) throw new Error(`${name} is not in ENV_VARS`)
  return v.fallback as T
}
