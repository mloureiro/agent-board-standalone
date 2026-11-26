import { describe, expect, it } from 'vitest';

import { ICONS, iconLabel } from '../src/components/icon-label.js';

describe('icon labels', () => {
  it('names every picker icon in words and keeps the emoji in the label', () => {
    for (const icon of ICONS) {
      const label = iconLabel(icon);
      expect(label).toContain(icon);
      expect(label.length).toBeGreaterThan(icon.length + 1);
    }
    expect(iconLabel('🚀')).toBe('Rocket 🚀');
  });

  it('falls back to the emoji for an icon outside the picker', () => {
    expect(iconLabel('🦓')).toBe('🦓');
  });
});
