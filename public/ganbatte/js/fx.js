/**
 * Die Dopamin-Abteilung: Konfetti, kurze Jubelmeldungen, Haptik.
 *
 * Alles selbst gemalt statt per Bibliothek - eine Konfetti-Funktion ist
 * dreißig Zeilen Canvas, und die App soll offline aus einem Ordner laufen,
 * ohne ein einziges fremdes Skript nachzuladen.
 *
 * Wer "Bewegung reduzieren" aktiviert hat, bekommt die Meldung ohne Animation.
 */

const reduceMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const COLORS = ['#e2703a', '#f4a259', '#f7c548', '#c8553d', '#7fb069', '#ffd9a0'];

let canvas = null;
let ctx = null;
let particles = [];
let running = false;

function ensureCanvas() {
  if (canvas) return;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function tick() {
  if (!ctx) return;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.life -= 1;
    p.vy += 0.22; // Schwerkraft
    p.vx *= 0.995;
    p.x += p.vx;
    p.y += p.vy;
    p.spin += p.spinSpeed;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.spin);
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 25));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    ctx.restore();
  }
  if (particles.length > 0) {
    requestAnimationFrame(tick);
  } else {
    running = false;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

/**
 * Konfetti-Salve. `origin` ist ein Punkt in Fensterkoordinaten - in der Regel
 * die Mitte des Buttons, den man gerade gedrückt hat, damit die Belohnung dort
 * entsteht, wo die Aktion war.
 */
export function confetti(origin = null, amount = 70) {
  if (reduceMotion()) return;
  ensureCanvas();
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  for (let i = 0; i < amount; i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const speed = 5 + Math.random() * 9;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 7,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      spin: Math.random() * Math.PI,
      spinSpeed: (Math.random() - 0.5) * 0.4,
      life: 60 + Math.random() * 45,
    });
  }
  // Nach oben gedeckelt, damit eine schnelle Klickserie das Bild nicht flutet.
  if (particles.length > 400) particles = particles.slice(-400);
  if (!running) {
    running = true;
    requestAnimationFrame(tick);
  }
}

/** Kurze Jubelmeldung oben am Bildschirm. */
export function toast(text, tone = 'fiesta') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.textContent = text;
  host.appendChild(el);
  // Alte Meldungen wegräumen, sonst stapelt sich der Bildschirm zu.
  while (host.children.length > 3) host.removeChild(host.firstChild);
  const life = reduceMotion() ? 2600 : 2200;
  setTimeout(() => {
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), 400);
  }, life);
}

/** Kurzes haptisches Feedback, wo das Gerät es kann (iOS kann es nicht). */
export function buzz(pattern = 12) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* egal */
    }
  }
}

/** Element kurz pulsieren lassen - für Zähler, die sich gerade erhöht haben. */
export function pulse(element) {
  if (!element || reduceMotion()) return;
  element.classList.remove('is-pulsing');
  // Reflow erzwingen, sonst startet die Animation beim zweiten Mal nicht neu.
  void element.offsetWidth;
  element.classList.add('is-pulsing');
}

/** Alle Belohnungen einer Aktion abspielen. */
export function party(events, origin) {
  if (!events || events.length === 0) return;
  for (const event of events) toast(event.text, event.kind === 'milestone' ? 'milestone' : 'fiesta');
  if (events.some((e) => e.kind === 'milestone')) {
    confetti(origin, 140);
    buzz([14, 60, 20]);
  } else {
    confetti(origin, 60);
    buzz();
  }
}
