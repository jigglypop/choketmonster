import { applyInterfacePreferences, DEFAULT_INTERFACE, readInterfacePreferences, writeInterfacePreferences, type InterfacePreferences } from './preferences';
import { getGameAudioSettings, setGameAudioSettings, resumeGameAudio } from '../audio';

export function mountInterfaceSettings(button: HTMLButtonElement): void {
  let preferences = { ...DEFAULT_INTERFACE }, revision = 0;
  let writes: Promise<void> = Promise.resolve();
  const dialog = document.createElement('dialog');
  dialog.id = 'interface-settings'; dialog.className = 'interface-settings';
  dialog.setAttribute('aria-labelledby', 'interface-settings-title');
  dialog.innerHTML = `<header class="settings-heading"><div><span class="settings-eyebrow">나에게 맞는 화면</span><h2 id="interface-settings-title">화면 설정</h2></div><button class="settings-close" aria-label="화면 설정 닫기">×</button></header>
    <p class="settings-description">바꾸는 즉시 적용됩니다. 설정은 이 기기에 기억합니다.</p>
    <section class="settings-preview" aria-label="글자 크기 미리보기"><div class="settings-preview-icon">Aa</div><div><strong>편하게 읽고, 가볍게 탐험하세요.</strong><p>기술 이름과 설명이 이 크기로 표시됩니다.</p></div></section>
    <div class="settings-fields">
      <label class="settings-field settings-font"><span><strong>글자 크기</strong><output id="interface-font-value" for="interface-font-size">100%</output></span><input id="interface-font-size" type="range" min="100" max="150" step="5" value="100"><small>기본 <span>크게</span></small></label>
      <label class="settings-field"><span><strong>정보 간격</strong><small>카드와 설명의 여백</small></span><select id="interface-density"><option value="comfortable">여유롭게</option><option value="compact">촘촘하게</option></select></label>
      <label class="settings-field"><span><strong>전투 패널 위치</strong><small>넓은 화면의 파트너·기술 패널</small></span><select id="interface-battle-position"><option value="right">오른쪽</option><option value="left">왼쪽</option><option value="bottom">아래 가운데</option></select></label>
      <label class="settings-field"><span><strong>팀 상세 배치</strong><small>좁은 화면에서는 한 열로 표시</small></span><select id="interface-team-layout"><option value="split">박스 옆에</option><option value="stack">넓게 한 열로</option></select></label>
      <label class="settings-field"><span><strong>패널 대비</strong><small>배경과 글씨를 더 뚜렷하게</small></span><select id="interface-contrast"><option value="normal">기본</option><option value="high">높게</option></select></label>
      <label class="settings-field"><span><strong>모험 음악</strong><small>내가 선택한 원곡 파일 · 이 기기에만 저장</small></span><input aria-label="음악 음량" id="audio-music" type="range" min="0" max="100" step="1"></label>
      <div class="settings-field settings-music-file"><span><strong>BGM 파일</strong><small id="audio-music-file-status">저장된 파일을 확인하는 중…</small></span><span><button type="button" id="audio-music-change">파일 선택·변경</button><button type="button" id="audio-music-remove" disabled>파일 제거</button></span></div>
      <label class="settings-field"><span><strong>포켓몬 효과음</strong><small>만남 · 공격 · 포획</small></span><input aria-label="효과음 음량" id="audio-effects" type="range" min="0" max="100" step="1"></label>
      <label class="settings-field"><span><strong>모든 소리 끄기</strong></span><input id="audio-muted" type="checkbox" aria-label="모든 소리 끄기"></label>
    </div><footer class="settings-footer"><button id="interface-reset">기본값으로</button><span id="interface-save-status" aria-live="polite"></span><button class="primary settings-done">완료</button></footer>`;
  document.body.append(dialog);
  const font = dialog.querySelector<HTMLInputElement>('#interface-font-size')!;
  const status = dialog.querySelector<HTMLElement>('#interface-save-status')!;
  const musicFileStatus = dialog.querySelector<HTMLElement>('#audio-music-file-status')!;
  const musicRemove = dialog.querySelector<HTMLButtonElement>('#audio-music-remove')!;
  document.addEventListener('choketmon:music-status', event => {
    const detail = (event as CustomEvent<{ message: string; hasFile: boolean; name?: string }>).detail;
    musicFileStatus.textContent = detail.name ? `${detail.name} · ${detail.message}` : detail.message;
    musicRemove.disabled = !detail.hasFile;
  });
  const syncControls = () => {
    const audio = getGameAudioSettings();
    dialog.querySelector<HTMLInputElement>('#audio-music')!.value = String(Math.round(audio.musicVolume * 100));
    dialog.querySelector<HTMLInputElement>('#audio-effects')!.value = String(Math.round(audio.effectsVolume * 100));
    dialog.querySelector<HTMLInputElement>('#audio-muted')!.checked = audio.muted;
    font.value = String(Math.round(preferences.fontScale * 100));
    dialog.querySelector<HTMLOutputElement>('#interface-font-value')!.value = `${font.value}%`;
    for (const [id, property] of [['density', 'density'], ['battle-position', 'battlePosition'], ['team-layout', 'teamLayout'], ['contrast', 'contrast']] as const) {
      dialog.querySelector<HTMLSelectElement>(`#interface-${id}`)!.value = preferences[property];
    }
  };
  const save = () => {
    const changedRevision = ++revision;
    applyInterfacePreferences(preferences); syncControls(); status.textContent = '저장 중…';
    const snapshot = { ...preferences };
    writes = writes.catch(() => {}).then(() => writeInterfacePreferences(snapshot)).then(() => {
      if (revision === changedRevision) status.textContent = '이 기기에 저장됨';
    }).catch(() => { if (revision === changedRevision) status.textContent = '저장 실패 · 설정을 다시 선택해 주세요'; });
  };
  font.oninput = () => { preferences.fontScale = Number(font.value) / 100; save(); };
  for (const [id, key] of [['music', 'musicVolume'], ['effects', 'effectsVolume']] as const) {
    dialog.querySelector<HTMLInputElement>(`#audio-${id}`)!.oninput = event => { setGameAudioSettings({ [key]: Number((event.target as HTMLInputElement).value) / 100 }); void resumeGameAudio(); status.textContent = '음량을 저장했습니다.'; };
  }
  dialog.querySelector<HTMLInputElement>('#audio-muted')!.onchange = event => { setGameAudioSettings({ muted: (event.target as HTMLInputElement).checked }); status.textContent = '소리 설정을 저장했습니다.'; };
  dialog.querySelector<HTMLButtonElement>('#audio-music-change')!.onclick = () => document.dispatchEvent(new Event('choketmon:music-select'));
  musicRemove.onclick = () => document.dispatchEvent(new Event('choketmon:music-remove'));
  for (const [id, property] of [['density', 'density'], ['battle-position', 'battlePosition'], ['team-layout', 'teamLayout'], ['contrast', 'contrast']] as const) {
    dialog.querySelector<HTMLSelectElement>(`#interface-${id}`)!.onchange = event => {
      preferences = { ...preferences, [property]: (event.target as HTMLSelectElement).value } as InterfacePreferences;
      save();
    };
  }
  dialog.querySelector<HTMLButtonElement>('#interface-reset')!.onclick = () => { preferences = { ...DEFAULT_INTERFACE }; save(); };
  for (const close of dialog.querySelectorAll<HTMLButtonElement>('.settings-close, .settings-done')) close.onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  button.onclick = () => { syncControls(); dialog.showModal(); document.dispatchEvent(new Event('choketmon:music-query')); };
  applyInterfacePreferences(preferences);
  void readInterfacePreferences().then(saved => {
    if (revision !== 0) return;
    preferences = saved; applyInterfacePreferences(preferences); syncControls();
  }).catch(() => { status.textContent = '이 기기에서 설정 저장을 사용할 수 없습니다.'; });
}
