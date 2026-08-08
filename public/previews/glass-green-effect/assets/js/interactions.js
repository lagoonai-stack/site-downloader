function downloadPage() {
  try {
    const html = document.documentElement.outerHTML;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (e) {
    window.open(window.location.href, '_blank');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      lucide.createIcons({ attrs: { 'stroke-width': 1.5 } });
    } else if (typeof lucide !== 'undefined' && typeof lucide.replace === 'function') {
      lucide.replace({ 'stroke-width': 1.5 });
    }
  } catch (err) {
    // ignore
  }

  // Custom cursor logic with snake-style trail
  const ring = document.getElementById('cursor-ring');
  const dot = document.getElementById('cursor-dot');
  if (!ring || !dot) return;

  let rafId;
  let targetX = window.innerWidth / 2, targetY = window.innerHeight / 2;
  let currentX = targetX, currentY = targetY;

  // Snake segments
  const SEGMENTS = 18;
  const segEls = [];
  const segX = new Array(SEGMENTS);
  const segY = new Array(SEGMENTS);
  let sizeBoost = 0;

  const createSegment = (i) => {
    const el = document.createElement('div');
    const z = 40; // under ring/dot (z-50)
    const baseSize = Math.max(4, 12 - i * 0.5);
    const opacity = Math.max(0.15, 0.9 - i * 0.04);
    el.className = 'pointer-events-none fixed top-0 left-0 hidden md:block';
    el.style.cssText = [
      `z-index:${z};`,
      `width:${baseSize}px;`,
      `height:${baseSize}px;`,
      'border-radius:9999px;',
      'transform:translate(-50%,-50%);',
      `background: rgba(94,234,212,${Math.min(0.95, 0.65 + (0.02 * (SEGMENTS - i))) });`,
      `box-shadow: 0 0 0 2px rgba(13,148,136,0.08), 0 0 18px rgba(20,184,166,0.25), inset 0 0 6px rgba(255,255,255,0.06);`,
      `opacity:${opacity};`,
      'transition: opacity .2s;',
      'will-change: left, top;'
    ].join('');
    document.body.appendChild(el);
    return el;
  };

  for (let i = 0; i < SEGMENTS; i++) {
    segEls[i] = createSegment(i);
    segX[i] = targetX;
    segY[i] = targetY;
  }

  const updateSegmentSizes = () => {
    for (let i = 0; i < SEGMENTS; i++) {
      const base = Math.max(4, 12 - i * 0.5);
      const size = base + sizeBoost;
      segEls[i].style.width = size + 'px';
      segEls[i].style.height = size + 'px';
    }
  };

  const setImmediate = (x, y) => {
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    for (let i = 0; i < SEGMENTS; i++) {
      segX[i] = x; segY[i] = y;
      segEls[i].style.left = x + 'px';
      segEls[i].style.top  = y + 'px';
    }
  };

  const animate = () => {
    // Lead ring follows smoothly
    currentX += (targetX - currentX) * 0.22;
    currentY += (targetY - currentY) * 0.22;
    ring.style.left = currentX + 'px';
    ring.style.top = currentY + 'px';

    // Dot snaps to target
    dot.style.left = targetX + 'px';
    dot.style.top = targetY + 'px';

    // Snake: head follows target, rest follow the previous segment
    segX[0] += (targetX - segX[0]) * 0.28;
    segY[0] += (targetY - segY[0]) * 0.28;

    for (let i = 1; i < SEGMENTS; i++) {
      segX[i] += (segX[i - 1] - segX[i]) * 0.28;
      segY[i] += (segY[i - 1] - segY[i]) * 0.28;
    }

    for (let i = 0; i < SEGMENTS; i++) {
      segEls[i].style.left = segX[i] + 'px';
      segEls[i].style.top  = segY[i] + 'px';
    }

    rafId = requestAnimationFrame(animate);
  };

  const onMove = (e) => {
    targetX = e.clientX;
    targetY = e.clientY;
  };

  const enlarge = () => {
    ring.style.width = '44px';
    ring.style.height = '44px';
    ring.style.borderColor = 'rgba(94, 234, 212, 1)';
    ring.style.boxShadow = '0 0 0 3px rgba(94,234,212,0.15), 0 0 60px rgba(20,184,166,0.35)';
    sizeBoost = 2;
    updateSegmentSizes();
  };

  const reset = () => {
    ring.style.width = '28px';
    ring.style.height = '28px';
    ring.style.borderColor = 'rgba(45, 212, 191, 0.85)';
    ring.style.boxShadow = '0 0 0 2px rgba(13,148,136,0.15), 0 0 30px rgba(20,184,166,0.25)';
    sizeBoost = 0;
    updateSegmentSizes();
  };

  const hide = () => {
    ring.style.opacity = '0';
    dot.style.opacity = '0';
    for (const el of segEls) el.style.opacity = '0';
  };

  const show = () => {
    ring.style.opacity = '.9';
    dot.style.opacity = '.9';
    for (let i = 0; i < SEGMENTS; i++) {
      const opacity = Math.max(0.15, 0.9 - i * 0.04);
      segEls[i].style.opacity = opacity;
    }
  };

  // Start animation
  setImmediate(window.innerWidth / 2, window.innerHeight / 2);
  show();
  updateSegmentSizes();
  rafId = requestAnimationFrame(animate);
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('mouseenter', show);
  window.addEventListener('mouseleave', hide);

  // Hover targets enlarge effect
  const hoverTargets = document.querySelectorAll('a, button, [role="button"], .cursor-glow, .button-hover, .tag-hover, .glow-border, .logo-hover, .hover-lift, .interactive-text');
  hoverTargets.forEach((el) => {
    el.addEventListener('mouseenter', enlarge);
    el.addEventListener('mouseleave', reset);
  });

  // Click feedback
  window.addEventListener('mousedown', () => {
    ring.style.transform = 'translate(-50%, -50%) scale(0.88)';
  });
  window.addEventListener('mouseup', () => {
    ring.style.transform = 'translate(-50%, -50%) scale(1)';
  });

  // Cleanup on page hide
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      rafId = requestAnimationFrame(animate);
    }
  });
});
