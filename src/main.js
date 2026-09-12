import { initUi, toast, showLoading, hideLoading, confirmDialog } from './core/ui.js';
import { createProject } from './project.js';
import {
  closeProjectDb,
  deleteProject,
  importLegacyOnce,
  listProjects,
  loadProject,
  saveProject,
} from './storage.js';
import { mountMeasure } from './tools/measure.js';
import { mountBuild } from './tools/build.js';

const dashboard = document.getElementById('dashboard');
const workspace = document.getElementById('workspace');
const projectGrid = document.getElementById('projectGrid');
const emptyProjects = document.getElementById('emptyProjects');
const projectTitle = document.getElementById('projectTitle');
const toolSwitchButtons = [...document.querySelectorAll('[data-toolview]')];

let current = null;
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

async function flushSave() {
  if (!current) return;
  clearTimeout(saveTimer);
  try {
    await saveProject(current.project);
  } catch (error) {
    console.warn('save failed', error && (error.message || error));
  }
}

function formatDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function renderProjects(projects) {
  projectGrid.textContent = '';
  emptyProjects.hidden = projects.length > 0;
  for (const meta of projects) {
    const card = document.createElement('article');
    card.className = 'project-card';
    const title = document.createElement('h3');
    title.textContent = meta.name || 'Untitled';
    const sub = document.createElement('p');
    sub.className = 'project-meta';
    sub.textContent = `${meta.hasUnderlay ? 'With plan' : 'Blank model'} · ${formatDate(meta.updatedAt)}`;
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    const measureBtn = document.createElement('button');
    measureBtn.className = 'ghost small';
    measureBtn.textContent = 'Measure';
    measureBtn.addEventListener('click', () => openProject(meta.id, 'measure'));
    const buildBtn = document.createElement('button');
    buildBtn.className = 'primary small';
    buildBtn.textContent = 'Build';
    buildBtn.addEventListener('click', () => openProject(meta.id, 'build'));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ghost small danger-text';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete "${meta.name}"?`);
      if (!ok) return;
      await deleteProject(meta.id);
      await refreshDashboard();
    });
    actions.append(measureBtn, buildBtn, deleteBtn);
    card.append(title, sub, actions);
    projectGrid.append(card);
  }
}

async function refreshDashboard() {
  try {
    const projects = await listProjects();
    renderProjects(projects);
  } catch (error) {
    console.warn('could not list projects', error && (error.message || error));
    renderProjects([]);
  }
}

function showDashboard() {
  flushSave();
  if (current) {
    current.instance?.destroy();
    current = null;
  }
  document.body.classList.remove('panel-hidden');
  workspace.hidden = true;
  dashboard.hidden = false;
  document.body.classList.remove('in-workspace');
  refreshDashboard();
}

function setToolButtons(tool) {
  for (const button of toolSwitchButtons) {
    button.classList.toggle('active', button.dataset.toolview === tool);
  }
}

// Only the active tool's toolbar and panel may be visible.
function hideToolChrome() {
  for (const id of ['measurePanel', 'buildPanel', 'measureToolbar', 'buildToolbar']) {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  }
}

async function mountTool(tool) {
  if (!current) return;
  if (current.tool === tool) return;
  current.instance?.destroy();
  hideToolChrome();
  current.tool = tool;
  const api =
    tool === 'measure'
      ? await mountMeasure({
          project: current.project,
          save: scheduleSave,
        })
      : await mountBuild({
          project: current.project,
          save: scheduleSave,
          getMeasureUnderlay: () => current.project.underlay,
        });
  current.instance = api;
  api.setActive(true);
  setToolButtons(tool);
}

async function openProject(id, tool) {
  showLoading('Opening project…');
  try {
    const project = await loadProject(id);
    if (!project) {
      toast('Project not found', true);
      return;
    }
    dashboard.hidden = true;
    workspace.hidden = false;
    document.body.classList.add('in-workspace');
    document.body.classList.add('panel-hidden');
    hideToolChrome();
    projectTitle.textContent = project.name;
    current = { project, tool: null, instance: null };
    current.tool = tool;
    const api =
      tool === 'measure'
        ? await mountMeasure({
            project,
            save: scheduleSave,
          })
        : await mountBuild({
            project,
            save: scheduleSave,
            getMeasureUnderlay: () => project.underlay,
          });
    current.instance = api;
    api.setActive(true);
    setToolButtons(tool);
  } catch (error) {
    console.error(error);
    toast('Could not open the project', true);
  } finally {
    hideLoading();
  }
}

async function createProjectWith(underlayFile, tool) {
  showLoading('Creating project…');
  try {
    let name = 'Untitled project';
    let underlay = null;
    if (underlayFile) {
      name = underlayFile.name.replace(/\.[^.]+$/, '');
      const buffer = await underlayFile.arrayBuffer();
      const type = underlayFile.type || '';
      underlay = {
        kind: type.includes('pdf') ? 'pdf' : 'image',
        name: underlayFile.name,
        sourceType: type,
        sourceBuffer: buffer,
        sourceBlob: null,
        pageCount: 1,
      };
    }
    const project = createProject({ name });
    project.underlay = underlay;
    await saveProject(project);
    await openProject(project.id, tool);
  } catch (error) {
    console.error(error);
    toast('Could not create the project', true);
    hideLoading();
  }
}

document.getElementById('newBlankBtn').addEventListener('click', () => createProjectWith(null, 'build'));
const newFileInput = document.getElementById('newFileInput');
document.getElementById('newFromPlanBtn').addEventListener('click', () => newFileInput.click());
newFileInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) createProjectWith(file, 'measure');
  event.target.value = '';
});

document.getElementById('backBtn').addEventListener('click', showDashboard);

for (const button of toolSwitchButtons) {
  button.addEventListener('click', async () => {
    if (!current) return;
    await mountTool(button.dataset.toolview);
  });
}

// Shared app-bar actions delegated to the active tool.
document.getElementById('fitBtn').addEventListener('click', () => current?.instance?.fit());
document.getElementById('undoBtn').addEventListener('click', () => current?.instance?.undo());
document.getElementById('redoBtn').addEventListener('click', () => current?.instance?.redo());
document.getElementById('deleteHandle').addEventListener('click', () => current?.instance?.requestDelete());

async function startup() {
  initUi();
  try {
    const migrated = await importLegacyOnce();
    if (migrated) {
      document.getElementById('projectTitle').textContent = migrated.name;
    }
  } catch (error) {
    console.warn('legacy import skipped', error && (error.message || error));
  }
  await refreshDashboard();
}

window.addEventListener('pagehide', () => {
  flushSave();
  closeProjectDb();
});

startup();
