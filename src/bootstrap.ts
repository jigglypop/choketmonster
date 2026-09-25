import { currentAccount, logout } from './game/account';
import { startupLoading } from './ui/loading-screen';
import { requireStartupAccount } from './ui/startup-auth';

void requireStartupAccount().then(() => import('./main')).catch(error => {
  startupLoading?.fail(`게임 파일을 불러오지 못했습니다. ${error instanceof Error ? error.message : String(error)}`, undefined, currentAccount() ? logout : undefined);
});
