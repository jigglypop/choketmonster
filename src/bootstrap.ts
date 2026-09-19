import { startupLoading } from './ui/loading-screen';

// Keep the illustrated shell visible while the game and renderer chunks load.
void import('./main').catch(error => {
  startupLoading?.fail(`게임 파일을 불러오지 못했습니다. ${error instanceof Error ? error.message : String(error)}`);
});
