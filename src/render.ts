import { Random } from './core/random';
import { HEIGHT, WIDTH, type Point, type World } from './core/world';
import type { BrainState } from './core/brain';

type Ctx = CanvasRenderingContext2D;
export function drawFly(ctx: Ctx, x: number, y: number, color: string, eye: string, size = 1, time = 0, face = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size * face, size);
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#354e40';
  const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string, rotate = 0) => {
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, rotate, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
  };
  ctx.fillStyle = '#294e3124'; ctx.beginPath(); ctx.ellipse(0, 24, 23, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(0, Math.sin(time * 0.004) * 2);
  const flap = Math.sin(time * 0.03) * 0.14;
  ellipse(-14, -14, 12, 24, '#f5faf3df', -0.65 + flap);
  ellipse(14, -14, 12, 24, '#f5faf3df', 0.65 - flap);
  ctx.strokeStyle = '#a2b3a3'; ctx.lineWidth = 1;
  for (const dir of [-1, 1]) { ctx.beginPath(); ctx.moveTo(dir * 6, 0); ctx.lineTo(dir * 23, -31); ctx.stroke(); }
  ctx.strokeStyle = '#354e40'; ctx.lineWidth = 2;
  for (const dir of [-1, 1]) for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(dir * 11, 3 + i * 5); ctx.lineTo(dir * (22 + i * 2), i * 9); ctx.stroke(); }
  ellipse(0, 7, 15, 20, color);
  ctx.beginPath(); ctx.moveTo(-12, 12); ctx.quadraticCurveTo(0, 18, 12, 12); ctx.moveTo(-9, 21); ctx.quadraticCurveTo(0, 24, 9, 21); ctx.stroke();
  ellipse(0, -6, 19, 15, color);
  ellipse(-12, -7, 9, 11, eye); ellipse(12, -7, 9, 11, eye);
  ellipse(-11, -8, 2.7, 4.5, '#293e36'); ellipse(13, -8, 2.7, 4.5, '#293e36');
  ctx.fillStyle = '#fffaf2'; ctx.fillRect(-13, -11, 2, 3); ctx.fillRect(11, -11, 2, 3);
  ctx.beginPath(); ctx.moveTo(-6, -18); ctx.quadraticCurveTo(-15, -33, -17, -23); ctx.moveTo(6, -18); ctx.quadraticCurveTo(15, -33, 17, -23); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, -1, 3, 0.15, Math.PI - 0.15); ctx.stroke();
  ctx.restore();
}
export function portrait(canvas: HTMLCanvasElement, color: string, eye: string, scale = 1) {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawFly(ctx, canvas.width / 2, canvas.height / 2 + 10, color, eye, scale, 0);
}
const tile = (p: Point) => ({ x: 62 + p.x * 52, y: 100 + p.y * 41 });
export function drawWorld(canvas: HTMLCanvasElement, world: World, color: string, eye: string, time: number, options: { trail: Point[]; showSensors: boolean; rival?: { world: World; color: string; eye: string } }) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#dce8c9'; ctx.fillRect(0, 0, w, h);
  const rng = new Random(779);
  // World coordinates and renderer share the same 16 x 10 traversable grid.
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const p = tile({ x, y });
    ctx.fillStyle = (x + y) % 2 ? '#e4edce' : '#e0eaca';
    ctx.fillRect(p.x - 26, p.y - 20, 52, 41);
  }
  for (let i = 0; i < 340; i++) {
    const x = rng.next() * w, y = rng.next() * h;
    ctx.strokeStyle = i % 3 ? '#93b27655' : '#fffcec88'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x, y - 4); ctx.lineTo(x + 2, y); ctx.stroke();
  }
  function shrub(x: number, y: number, size = 1) {
    ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
    ctx.fillStyle = '#668a6040'; ctx.beginPath(); ctx.ellipse(1, 18, 28, 10, 0, 0, Math.PI * 2); ctx.fill();
    for (const [dx, dy, r, fill] of [[-16, 1, 18, '#8cab70'], [15, 0, 19, '#86a568'], [0, -12, 23, '#a0bb7b']] as const) {
      ctx.beginPath(); ctx.arc(dx, dy, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    }
    ctx.strokeStyle = '#bfce91'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(-6, -14, 10, 3.2, 4.9); ctx.stroke(); ctx.restore();
  }
  for (let i = 0; i < 17; i++) { shrub(i * 58 - 5, 33 + (i % 2) * 8, 1.1); shrub(i * 57, h - 19 + (i % 2) * 10, 1); }
  for (let i = 0; i < 7; i++) { shrub(0, i * 65 + 80, 0.85); shrub(w, i * 65 + 90, 0.9); }
  if (options.trail.length > 1) {
    ctx.strokeStyle = '#69896b66'; ctx.lineWidth = 2; ctx.setLineDash([3, 8]); ctx.beginPath();
    options.trail.forEach((p, i) => { const c = tile(p); if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y); }); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const hazard of world.hazards) {
    const p = tile(hazard);
    ctx.fillStyle = '#b4857930'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 8, 20, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f2e8cc'; ctx.fillRect(p.x - 4, p.y - 5, 8, 15);
    ctx.beginPath(); ctx.ellipse(p.x, p.y - 7, 17, 11, 0, Math.PI, 0); ctx.fillStyle = '#c78779'; ctx.fill();
    ctx.fillStyle = '#efd6b3'; ctx.fillRect(p.x - 9, p.y - 14, 4, 3); ctx.fillRect(p.x + 3, p.y - 16, 4, 3);
  }
  function fruit(p: Point, opacity = 1) {
    const c = tile(p); ctx.save(); ctx.globalAlpha = opacity;
    ctx.strokeStyle = '#c78a5e33'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(c.x, c.y, 22 + Math.sin(time * 0.003) * 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#b9906240'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 10, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#edab61'; ctx.strokeStyle = '#ba8050'; ctx.beginPath(); ctx.arc(c.x - 4, c.y, 9, 0, Math.PI * 2); ctx.arc(c.x + 5, c.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#91a45f'; ctx.beginPath(); ctx.ellipse(c.x + 4, c.y - 13, 7, 3, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff1c4'; ctx.fillRect(c.x - 8, c.y - 5, 3, 4); ctx.restore();
  }
  fruit(world.food);
  if (options.rival) fruit(options.rival.world.food, 0.45);
  const p = tile(world.position);
  if (options.showSensors) {
    const food = tile(world.food);
    ctx.strokeStyle = '#73966288'; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(food.x, food.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(p.x, p.y, 47, 0, Math.PI * 2); ctx.strokeStyle = '#7d9a6e55'; ctx.stroke();
  }
  if (options.rival) {
    const rp = tile(options.rival.world.position);
    drawFly(ctx, rp.x + 7, rp.y - 9, options.rival.color, options.rival.eye, 0.75, time + 100);
  }
  drawFly(ctx, p.x, p.y - 10, color, eye, 0.85, time);
  if (world.lastReward > 2) { ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = '#537342'; ctx.textAlign = 'center'; ctx.fillText('+ 열매', p.x, p.y - 55); }
}
export function drawBrain(canvas: HTMLCanvasElement, brain: BrainState) {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const n = Math.min(brain.activity.length, 64);
  const rng = new Random(182);
  const points = Array.from({ length: n }, (_, i) => {
    const t = i / n * Math.PI * 2, r = 32 + rng.next() * 47;
    return { x: 140 + Math.cos(t) * r * 1.32, y: 88 + Math.sin(t) * r * 0.8 };
  });
  for (const edge of brain.graph.edges) {
    if (edge.source >= n || edge.target >= n) continue;
    const a = points[edge.source], b = points[edge.target];
    ctx.strokeStyle = Math.abs(brain.activity[edge.source]) > 0.45 ? '#c7e79335' : '#80978922';
    ctx.lineWidth = 0.65; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = Math.abs(brain.activity[i]);
    ctx.fillStyle = a > 0.45 ? '#d2ed9e' : '#65897a'; ctx.beginPath(); ctx.arc(points[i].x, points[i].y, 2 + a * 2.2, 0, Math.PI * 2); ctx.fill();
  }
}
