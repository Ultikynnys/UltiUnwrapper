import { BUILD_LABEL } from '../lib/buildInfo';

const STEP_PLACEHOLDERS = [
  'Condition',
  'Segment',
  'Parameterize',
  'Normalize density',
  'Pack atlas',
  'Validate',
];

export function renderShell(root: HTMLElement): void {
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-group">
          <span class="brand" aria-label="UltiUnwrapper">
            <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            <span>ULTI<span>UNWRAPPER</span></span>
          </span>
          <span class="build-version" title="Build version and commit">${BUILD_LABEL}</span>
        </div>
        <div class="topbar-actions">
          <button class="button" id="importModel" type="button">Import model</button>
          <button class="button button-primary" id="runUnwrap" type="button" disabled>Unwrap</button>
        </div>
      </header>
      <main class="workspace">
        <aside class="step-column" aria-label="Unwrap stages">
          <div class="panel-heading">
            <span>Stages</span>
            <span class="panel-meta">after run</span>
          </div>
          <ol class="step-list" id="stepList">
            ${STEP_PLACEHOLDERS.map((label, index) => `
              <li class="step-item is-empty" data-step="${index}">
                <span class="step-index">${String(index + 1).padStart(2, '0')}</span>
                <span class="step-body">
                  <span class="step-name">${label}</span>
                  <span class="step-metric">Not run</span>
                </span>
              </li>
            `).join('')}
          </ol>
          <div class="step-note">
            Every stage keeps its own UVs, charts, and metrics. Inspect any step after the unwrap finishes.
          </div>
        </aside>
        <section class="stage-column" aria-label="Unwrap workspace">
          <div class="stage-empty" id="stageEmpty">
            <div class="empty-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <h1>Unwrap, then inspect every step</h1>
            <p>Import an FBX, OBJ, glTF, or GLB mesh. UltiUnwrapper runs a staged unwrap and keeps each stage's layout, seam set, texel density, distortion, and overlap so weaknesses are visible after the run.</p>
            <div class="empty-actions">
              <button class="button button-primary" id="emptyImport" type="button">Import model</button>
              <span class="empty-hint">or drop a model bundle anywhere</span>
            </div>
          </div>
        </section>
        <aside class="inspector" aria-label="Run settings">
          <div class="panel-heading">
            <span>Run settings</span>
            <span class="panel-meta">v1</span>
          </div>
          <div class="inspector-empty">
            <p>Model intake, stage views, texel density, distortion, and atlas diagnostics are wired in the next step of the build.</p>
            <dl class="readout">
              <div><dt>Atlas</dt><dd>2048 px</dd></div>
              <div><dt>Padding</dt><dd>8 px</dd></div>
              <div><dt>Seam angle</dt><dd>66 deg</dd></div>
              <div><dt>Texel density</dt><dd>512 px/unit</dd></div>
            </dl>
          </div>
        </aside>
      </main>
      <input id="modelFileInput" type="file" accept=".fbx,.obj,.gltf,.glb" multiple hidden />
    </div>
  `;
}
