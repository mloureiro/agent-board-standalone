const invoke = window.__TAURI_INTERNALS__.invoke;

invoke('pair_state').then((shown) => {
  const code = document.getElementById('code');
  const note = document.getElementById('note');
  if (shown.type === 'pair-code') {
    code.textContent = shown.code;
    const until = new Date(shown.expiresAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    note.textContent = `Enter it on the device within ${shown.validForSeconds / 60} minutes (until ${until}). It works once.`;
  } else {
    note.textContent = shown.message;
  }
});

document.getElementById('close').addEventListener('click', () => invoke('close_self'));
