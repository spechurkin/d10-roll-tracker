const THEME_BY_SYSTEM_ID = Object.freeze({
  "cyberpunk-red-core": "cyberpunk",
  worldofdarkness: "worldofdarkness",
  wod5e: "wod5e",
});

export function themeNameForSystem(systemId) {
  return THEME_BY_SYSTEM_ID[systemId] ?? "foundry";
}

export function themeClassForSystem(systemId) {
  return `roll-tracker-theme-${themeNameForSystem(systemId)}`;
}
