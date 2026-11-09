// Build identity shown in the app and used by the update check.
// CI overwrites this file with scripts/stamp-version.mjs before building;
// local builds keep commit "dev".
export const APP_VERSION = {
  version: '1.0.0',
  commit: 'dev',
  builtAt: '',
};
