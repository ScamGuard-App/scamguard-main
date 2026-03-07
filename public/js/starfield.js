// Adjustable parallax starfield generator.
// Tweak STAR_COUNTS to control density globally.
(function () {
  const STAR_COUNTS = {
    small: 220,
    medium: 90,
    large: 40,
  };

  const FIELD_SIZE = 2000;

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
