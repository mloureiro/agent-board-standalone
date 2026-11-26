const invoke = window.__TAURI_INTERNALS__.invoke;
const inputs = [
  {
    field: 'token',
    input: document.getElementById('token'),
    count: document.getElementById('token-count'),
  },
  {
    field: 'data-key',
    input: document.getElementById('data-key'),
    count: document.getElementById('data-key-count'),
  },
];
const status = document.getElementById('status');
const connect = document.getElementById('connect');
const close = document.getElementById('close');
let polling;

function render(view) {
  view.fields.forEach((field, index) => {
    const { input, count } = inputs[index];
    count.textContent = field.count === 1 ? '1 character' : `${field.count} characters`;
    if (field.count === 0) input.value = '';
    input.disabled = !view.can_close;
  });
  status.textContent = view.status ?? '';
  connect.disabled = !view.connect_enabled;
  close.disabled = !view.can_close;
  if (view.can_close && polling !== undefined) {
    clearInterval(polling);
    polling = undefined;
  }
}

for (const { field, input } of inputs) {
  input.addEventListener('input', async () =>
    render(await invoke('enrol_set', { field, value: input.value })),
  );
}

document.getElementById('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  render(await invoke('enrol_connect'));
  polling ??= setInterval(async () => render(await invoke('enrol_state')), 250);
});

close.addEventListener('click', () => invoke('close_self'));

invoke('enrol_state').then(render);
