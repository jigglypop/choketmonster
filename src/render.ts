import { Random } from './core/random';
import type { BrainState } from './core/brain';

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
