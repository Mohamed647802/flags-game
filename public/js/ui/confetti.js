// قصاصات احتفالية على canvas — حد أقصى 120 جسيماً، مع تنظيف بعد الانتهاء.
const COLORS = ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#f78c6b', '#a78bfa', '#ffffff'];

export function startConfetti(canvas, durationMs = 2600) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);

  const particles = [];
  const count = 120;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.3,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 2 + Math.random() * 3.4,
      size: 5 + Math.random() * 7,
      color: COLORS[i % COLORS.length],
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.2,
      shape: Math.random() < 0.5 ? 'rect' : 'circle',
    });
  }

  let raf = 0;
  let stopped = false;
  const start = performance.now();

  function frame(now) {
    if (stopped) return;
    const elapsed = now - start;
    ctx.clearRect(0, 0, w, h);
    for (const p of particles) {
      p.x += p.vx + Math.sin((now / 300) + p.rot) * 0.6;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (elapsed < durationMs) {
      raf = requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
  }
  raf = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, w, h);
  };
}
