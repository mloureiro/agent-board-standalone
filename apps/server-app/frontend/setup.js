const invoke = window.__TAURI_INTERNALS__.invoke;
const byId = (id) => document.getElementById(id);
const publicUrl = byId('public-url');
const message = byId('message');
let shownPort;

function say(text) {
  message.textContent = text ?? '';
}

function restartNote(view) {
  const restart = view.restart;
  if (restart === undefined || restart.ok !== false) return '';
  return `Saved, but the server did not restart: ${restart.message}. Use Restart server in the tray.`;
}

function render(view) {
  const status = view.status;
  if (status.port !== shownPort) {
    shownPort = status.port;
    byId('tailscale').textContent = `tailscale funnel --bg ${status.port}`;
    byId('cloudflared').textContent = `cloudflared tunnel --url http://127.0.0.1:${status.port}`;
  }
  if (status.remote) {
    publicUrl.value = status.publicUrl;
    byId('remote-state').textContent = `On at ${status.publicUrl}: sign-in with passkeys.`;
  } else {
    byId('remote-state').textContent = 'Off: this Mac only, without sign-in.';
  }
  byId('remote-off').disabled = !status.remote;

  byId('sign-in-local').hidden = status.remote;
  byId('sign-in-remote').hidden = !status.remote;
  byId('passkey-done').hidden = !status.firstPasskeyOpen;
  if (!status.firstPasskeyOpen) byId('passkey-open').hidden = true;
  byId('passkey-create').textContent = status.firstPasskeyOpen
    ? 'Create a new token'
    : 'Create my first passkey';

  byId('worker-state').textContent = status.workerConnected
    ? 'A worker is connected.'
    : 'No worker is connected yet.';

  byId('phone-text').textContent = status.remote
    ? `On the phone, add ${status.publicUrl}, choose Sign in with your browser, and approve the code it shows from a signed-in browser.`
    : 'Turn on remote access first.';
}

function showToken(view) {
  byId('passkey-name').textContent = view.userName;
  byId('passkey-token').textContent = view.token;
  byId('passkey-url').textContent = view.signUpUrl;
  byId('passkey-open').hidden = false;
}

async function run(command, args, after) {
  say('');
  try {
    const view = await invoke(command, args);
    render(view);
    if (after) after(view);
    const note = restartNote(view);
    if (note) say(note);
  } catch (error) {
    say(String(error));
  }
}

byId('remote-on').addEventListener('click', () =>
  run('setup_remote', { publicUrl: publicUrl.value }),
);
byId('remote-off').addEventListener('click', () => run('setup_remote', { publicUrl: null }));
byId('passkey-create').addEventListener('click', () =>
  run('setup_first_passkey', {}, (view) => {
    showToken(view);
    if (view.browserFailure) say(`The browser did not open: ${view.browserFailure}`);
  }),
);
byId('passkey-done').addEventListener('click', () => run('setup_first_passkey_done', {}));
byId('connect-worker').addEventListener('click', () =>
  invoke('setup_connect_worker').catch((error) => say(String(error))),
);
byId('close').addEventListener('click', () => invoke('close_self'));

const refresh = () =>
  invoke('setup_state')
    .then(render)
    .catch((error) => say(String(error)));
refresh();
setInterval(() => {
  if (document.activeElement !== publicUrl) refresh();
}, 3000);
