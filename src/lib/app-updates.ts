export function createUpdateChecker(options: {
  currentVersion: string;
  loadVersion: () => Promise<string | undefined>;
  canReload: () => boolean;
  rememberReload: (version: string) => boolean;
  reload: () => void;
}) {
  let available: string | undefined;
  let checking = false;
  let reloading = false;
  function apply() {
    if (!available || reloading || !options.canReload() || !options.rememberReload(available)) return;
    reloading = true;
    options.reload();
  }
  return {
    apply,
    async check() {
      if (checking || reloading) return;
      checking = true;
      try {
        const version = await options.loadVersion();
        available = version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) && version !== options.currentVersion ? version : undefined;
        apply();
      } catch { /* Keep the current application usable when its static server is unavailable. */ }
      finally { checking = false; }
    },
  };
}
