import { startupLoading } from './ui/loading-screen';

// Load the game immediately; the shell only appears if startup fails.
void import('./main').catch(error => {
  startupLoading?.fail(`게임 파일을 불러오지 못했습니다. ${error instanceof Error ? error.message : String(error)}`);
});
