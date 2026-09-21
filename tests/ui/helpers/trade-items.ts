import type { Graph } from '../../../src/core/brain';
import type { User } from '../../../src/game/account';
import * as storage from '../../../src/game/storage';
import { mountTradePanel } from '../../../src/game/trade-panel';

export async function startTradeItemPanel({ user, graph }: { user: User; graph: Graph }) {
  const initial = await storage.activateSaveProfile(user);
  let current = storage.unpackSave(initial, graph);
  const panel = mountTradePanel({
    container: document.body,
    game: () => current.game,
    graph: () => graph,
    currentAccount: () => user,
    prepare: async () => {},
    applied: save => { current = storage.unpackSave(save, graph); },
  });
  Object.assign(window, { tradeItemPanel: { open: () => panel.open() } });
  await panel.open();
}
