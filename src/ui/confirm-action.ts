type Confirmation = {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
  destructive?: boolean;
};

/** App-styled confirmation with native modal focus containment and Escape cancellation. */
export function confirmAction(options: Confirmation): Promise<boolean> {
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  dialog.setAttribute('aria-labelledby', 'confirmation-title');
  dialog.setAttribute('aria-describedby', 'confirmation-message confirmation-detail');
  dialog.innerHTML = `<header><h2 id="confirmation-title"></h2><button type="button" class="confirmation-close" aria-label="확인 창 닫기">×</button></header>
    <div class="confirmation-body"><p id="confirmation-message"></p><p id="confirmation-detail"></p></div>
    <form method="dialog"><button value="cancel" class="confirmation-cancel" autofocus>취소</button><button value="confirm" class="confirmation-accept"></button></form>`;
  dialog.querySelector('#confirmation-title')!.textContent = options.title;
  dialog.querySelector('#confirmation-message')!.textContent = options.message;
  dialog.querySelector('#confirmation-detail')!.textContent = options.detail;
  const accept = dialog.querySelector<HTMLButtonElement>('.confirmation-accept')!;
  accept.textContent = options.confirmLabel;
  accept.classList.toggle('destructive', !!options.destructive);
  dialog.querySelector<HTMLButtonElement>('.confirmation-close')!.onclick = () => dialog.close('cancel');
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      dialog.remove(); resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
  });
}
