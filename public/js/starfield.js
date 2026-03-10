// Adjustable parallax starfield generator.
(function () {
  const STAR_COUNTS = {
    // Seems like a good amount for now
    small: 220,
    medium: 90,
    large: 40,
  };

  // Maximum field size
  const FIELD_SIZE = 2000;

  // Generate the star field at a size between 0 and field_size
  function buildShadows(count) {
    const points = [];
    for (let i = 0; i < count; i += 1) {
      const x = Math.floor(Math.random() * FIELD_SIZE);
      const y = Math.floor(Math.random() * FIELD_SIZE);
      points.push(`${x}px ${y}px #FFF`);
    }
    return points.join(', ');
  }

  function applyStarfield() {
    // Check accessibility settings
    if (document.documentElement.hasAttribute('data-a11y-starfield-disabled')) {
      return;
    }

    // CSS animation uses these custom properties as box-shadow lists.
    const root = document.documentElement;
    root.style.setProperty('--stars-small', buildShadows(STAR_COUNTS.small));
    root.style.setProperty('--stars-medium', buildShadows(STAR_COUNTS.medium));
    root.style.setProperty('--stars-large', buildShadows(STAR_COUNTS.large));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyStarfield, { once: true });
  } else {
    applyStarfield();
  }
})();
