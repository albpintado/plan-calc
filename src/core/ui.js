export const ui = {
  status: document.getElementById('status'),
  confirmBackdrop: document.getElementById('confirmBackdrop'),
  confirmText: document.getElementById('confirmText'),
  confirmOk: document.getElementById('confirmOk'),
  confirmCancel: document.getElementById('confirmCancel'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  calibDialog: document.getElementById('calibDialog'),
  calibInput: document.getElementById('calibInput'),
  calibUnit: document.getElementById('calibUnit'),
  calibOk: document.getElementById('calibOk'),
  calibCancel: document.getElementById('calibCancel'),
  calibError: document.getElementById('calibError'),
};

let statusTimer = null;
let pendingCalibration = null;

export function toast(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
  ui.status.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ui.status.classList.remove('show'), 2600);
}

export function showLoading(text = 'Loading…') {
  ui.loadingText.textContent = text;
  ui.loading.hidden = false;
}

export function hideLoading() {
  ui.loading.hidden = true;
}

export function confirmDialog(message) {
  return new Promise((resolve) => {
    if (!message) {
      resolve(true);
      return;
    }
    ui.confirmText.textContent = message;
    ui.confirmBackdrop.hidden = false;
    ui.confirmOk.focus();
    const done = (value) => {
      ui.confirmBackdrop.hidden = true;
      ui.confirmOk.removeEventListener('click', onOk);
      ui.confirmCancel.removeEventListener('click', onCancel);
      ui.confirmBackdrop.removeEventListener('click', onBackdrop);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (event) => {
      if (event.target === ui.confirmBackdrop) done(false);
    };
    ui.confirmOk.addEventListener('click', onOk);
    ui.confirmCancel.addEventListener('click', onCancel);
    ui.confirmBackdrop.addEventListener('click', onBackdrop);
  });
}

export function openCalibrationDialog(position, onConfirm) {
  pendingCalibration = onConfirm;
  ui.calibDialog.hidden = false;
  ui.calibError.hidden = true;
  const rect = document.getElementById('canvas').getBoundingClientRect();
  const width = ui.calibDialog.offsetWidth || 250;
  const height = ui.calibDialog.offsetHeight || 150;
  ui.calibDialog.style.left = `${Math.min(Math.max(8, rect.left + (position?.x || 0)), window.innerWidth - width - 8)}px`;
  ui.calibDialog.style.top = `${Math.min(Math.max(8, rect.top + (position?.y || 0)), window.innerHeight - height - 8)}px`;
  ui.calibInput.value = '';
  ui.calibInput.focus();
}

export function closeCalibrationDialog() {
  ui.calibDialog.hidden = true;
  ui.calibError.hidden = true;
  pendingCalibration = null;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const type = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initUi() {
  ui.calibOk.addEventListener('click', () => {
    const value = Number.parseFloat(ui.calibInput.value.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      ui.calibError.textContent = 'Enter a positive number';
      ui.calibError.hidden = false;
      return;
    }
    const handler = pendingCalibration;
    closeCalibrationDialog();
    if (handler) handler(value, ui.calibUnit.value);
  });
  ui.calibCancel.addEventListener('click', closeCalibrationDialog);
  ui.calibInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ui.calibOk.click();
    if (event.key === 'Escape') closeCalibrationDialog();
  });
}
