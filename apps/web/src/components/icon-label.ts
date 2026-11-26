const ICON_NAMES: Readonly<Record<string, string>> = {
  '🚀': 'Rocket',
  '🐛': 'Bug',
  '✨': 'Sparkles',
  '🔧': 'Wrench',
  '📝': 'Memo',
  '🧪': 'Test tube',
  '🔍': 'Magnifying glass',
  '📦': 'Package',
  '🔒': 'Lock',
  '⚡': 'Lightning',
  '🎨': 'Palette',
  '📈': 'Chart',
  '🧹': 'Broom',
  '📚': 'Books',
  '🌐': 'Globe',
  '💡': 'Light bulb',
  '🔥': 'Fire',
  '✅': 'Check mark',
  '⚠️': 'Warning',
  '🗑️': 'Wastebasket',
  '🔌': 'Plug',
  '🧩': 'Puzzle piece',
  '🛠️': 'Hammer and wrench',
  '🏗️': 'Construction',
};

export const ICONS = Object.keys(ICON_NAMES);

export function iconLabel(icon: string): string {
  const name = ICON_NAMES[icon];
  return name === undefined ? icon : `${name} ${icon}`;
}
