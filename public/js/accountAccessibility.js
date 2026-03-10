(function () {
  // Persistent settings.
  const STORAGE_KEY = 'scamguardAccessibilitySettings';
  const LEGACY_STORAGE_KEY = 'accountAccessibilitySettings';

  const controls = {
    monospace: document.getElementById('a11yMonospace'),
    disableBackground: document.getElementById('a11yDisableBackground'),
    reduceMotion: document.getElementById('a11yReduceMotion'),
  };

  function readSavedSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw && !legacyRaw) {
        return {
          monospace: false,
          disableBackground: false,
          reduceMotion: false,
        };
      }

      const parsed = JSON.parse(raw || legacyRaw);
      // Coerce everything to booleans in case localStorage contains weird legacy values.
      return {
        monospace: Boolean(parsed.monospace),
        disableBackground: Boolean(parsed.disableBackground),
        reduceMotion: Boolean(parsed.reduceMotion),
      };
    } catch (error) {
      return {
        monospace: false,
        disableBackground: false,
        reduceMotion: false,
      };
    }
  }

  function persistSettings(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(settings));
    } catch (error) {
      // If storage is blocked (private mode, quota), keep working for this session.
    }
  }

  function applySettings(settings) {
    // HTML attributes are consumed by shared CSS and page bootstraps.
    document.documentElement.toggleAttribute('data-a11y-font', settings.monospace);
    document.documentElement.toggleAttribute(
      'data-a11y-starfield-disabled',
      settings.disableBackground
    );
    document.documentElement.toggleAttribute('data-a11y-reduce-motion', settings.reduceMotion);

  // Accessibility toggles.
    document.body.classList.toggle('a11y-monospace', settings.monospace);
    document.body.classList.toggle('a11y-no-background', settings.disableBackground);
    document.body.classList.toggle('a11y-reduce-motion', settings.reduceMotion);
  }

  function syncControlState(settings) {
    if (controls.monospace) controls.monospace.checked = settings.monospace;
    if (controls.disableBackground) controls.disableBackground.checked = settings.disableBackground;
    if (controls.reduceMotion) controls.reduceMotion.checked = settings.reduceMotion;
  }

  function currentSettingsFromControls() {
    return {
      monospace: Boolean(controls.monospace && controls.monospace.checked),
      disableBackground: Boolean(
        controls.disableBackground && controls.disableBackground.checked
      ),
      reduceMotion: Boolean(controls.reduceMotion && controls.reduceMotion.checked),
    };
  }

  function handleChange() {
    const settings = currentSettingsFromControls();
    applySettings(settings);
    persistSettings(settings);
  }

  const savedSettings = readSavedSettings();
  // Apply before syncing controls so the UI always reflects the current state.
  applySettings(savedSettings);
  syncControlState(savedSettings);

  if (controls.monospace) controls.monospace.addEventListener('change', handleChange);
  if (controls.disableBackground) {
    controls.disableBackground.addEventListener('change', handleChange);
  }
  if (controls.reduceMotion) controls.reduceMotion.addEventListener('change', handleChange);
})();
