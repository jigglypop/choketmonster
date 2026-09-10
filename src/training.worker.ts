import { Brain } from './core/brain';
import { runEpisode } from './core/episode';

self.onmessage = (event: MessageEvent) => {
  try {
    const { checkpoint, episodes, startSeed } = event.data;
    if (!Number.isInteger(episodes) || episodes < 1 || episodes > 100) throw new Error('Training budget exceeded');
    const brain = Brain.restore(checkpoint);
    let food = 0;
    for (let i = 0; i < episodes; i++) {
      food += runEpisode(brain, startSeed + i, { learning: true }).food;
      if ((i + 1) % 10 === 0) self.postMessage({ type: 'progress', completed: i + 1, total: episodes });
    }
    self.postMessage({ type: 'complete', checkpoint: brain.snapshot(), episodes, food });
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Training failed' }); }
};
