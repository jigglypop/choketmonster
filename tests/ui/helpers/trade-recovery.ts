import type { Graph } from '../../../src/core/brain';
import type { User } from '../../../src/game/account';
import * as storage from '../../../src/game/storage';
import * as brain from '../../../src/game/server-brain';
import { mountTradePanel } from '../../../src/game/trade-panel';

export async function startTradeRecovery({ user, graph, failure }: { user: User; graph: Graph; failure: 'neural-cache' | 'game-application' }) {
  const initialSave = await storage.activateSaveProfile(user);
  let current = storage.unpackSave(initialSave, graph), applyAttempts = 0, applied = 0, closed = 0, failureEnabled = true;
  await brain.initializeServerBrain(); brain.setServerBrainScope(`account:${user.id}:${current.game.seed}`);
  if (failure === 'neural-cache') {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (this.name === 'choketmon-neural-cache' && args[1] === 'readwrite') {
        if (failureEnabled) throw new DOMException('Injected temporary neural cache failure', 'UnknownError');
        IDBDatabase.prototype.transaction = transaction;
      }
      return transaction.apply(this, args);
    };
  }
  const panel = mountTradePanel({ container: document.body, game: () => current.game, graph: () => graph, currentAccount: () => user,
    prepare: async () => {},
    applied: async save => {
      applyAttempts++;
      if (failure === 'game-application' && failureEnabled) throw new Error('Injected temporary game application failure');
      current = storage.unpackSave(save, graph); applied++;
    },
    closed: () => { closed++; },
  });
  Object.assign(window, { tradeRecovery: {
    open: () => panel.open(),
    state: () => ({ money: current.game.player.money, species: current.game.player.box.map(monster => monster.speciesId), applyAttempts, applied, closed }),
    stored: () => storage.readSave(),
    recover: () => { failureEnabled = false; },
    save: () => storage.writeSave(storage.packSave(current.game, graph, current.view)),
  } });
  await panel.open();
}
