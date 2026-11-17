import { BUILD_LABEL } from '../lib/buildInfo';

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
          <span class="run-status is-idle" id="runStatus">IDLE</span>
        </div>
        <div class="topbar-actions">
          <button class="button button-quiet" id="loadDemo" type="button">Demo cube</button>
          <label class="button" id="importModel" for="modelFileInput" role="button" tabindex="0">Import model</label>
          <button class="button button-primary" id="runUnwrap" type="button" disabled>Unwrap</button>
          <span class="topbar-divider" aria-hidden="true"></span>
          <button class="button button-quiet" id="exportObj" type="button" title="Download unwrapped OBJ" disabled>OBJ</button>
          <button class="button button-quiet" id="exportGlb" type="button" title="Download unwrapped GLB" disabled>GLB</button>
          <button class="button button-quiet" id="exportReport" type="button" title="Download JSON report" disabled>Report</button>
        </div>
      </header>

      <main class="workspace">
        <aside class="step-column" aria-label="Unwrap stages">
          <div class="panel-heading">
            <span>Stages</span>
            <span class="panel-meta" id="stageProgress">not run</span>
          </div>
          <ol class="step-list" id="stepList"></ol>
          <div class="run-summary" id="runSummary">
            <span class="summary-empty">Import a model to begin.</span>
          </div>
          <div class="step-note">
            Every stage keeps its own UVs, charts, and metrics. Inspect any step after the unwrap finishes.
          </div>
        </aside>

        <section class="stage-column" id="stageColumn" aria-label="Unwrap workspace">
          <div class="stage-toolbar">
            <div class="stage-heading">
              <h1 id="stageTitle">No unwrap yet</h1>
              <p id="stageSubtitle">Import a model, run the unwrap, then step through every stage.</p>
            </div>
            <div class="stage-controls">
              <label class="select-control" title="What the 3D viewport draws">
                <span>View</span>
                <select id="viewMode" disabled></select>
              </label>
              <label class="toggle-control" title="Draw chart borders and cut paths">
                <input type="checkbox" id="toggleSeams" checked disabled />
                <span>Seams</span>
              </label>
              <label class="toggle-control" title="Draw the triangle wireframe">
                <input type="checkbox" id="toggleWireframe" disabled />
                <span>Wireframe</span>
              </label>
              <button class="button button-quiet button-compact" id="clearChart" type="button" disabled>Clear chart</button>
            </div>
          </div>

          <div class="stage-grid">
            <div class="viewport-pane">
              <canvas id="viewportCanvas" aria-label="3D stage viewport"></canvas>
              <div class="viewport-hud" id="viewportHud">No mesh loaded</div>
              <div class="busy-overlay" id="busyOverlay" hidden>
                <span class="busy-spinner" aria-hidden="true"></span>
                <span id="busyText">Running unwrap</span>
              </div>
            </div>
            <div class="atlas-pane">
              <canvas id="atlasCanvas" aria-label="UV atlas or chart gallery"></canvas>
              <div class="atlas-hint" id="atlasHint">Atlas appears after parameterization</div>
            </div>
          </div>

          <div class="metric-strip" id="metricStrip">
            <div class="metric-empty">Stage metrics appear here.</div>
          </div>
        </section>

        <aside class="inspector" aria-label="Stage diagnostics">
          <div class="panel-heading">
            <span>Stage details</span>
            <span class="panel-meta" id="detailsMeta">-</span>
          </div>
          <div class="stage-details" id="stageDetails">
            <p class="inspector-empty">Stats and issues for the selected stage.</p>
          </div>

          <div class="panel-heading">
            <span>Distribution</span>
            <span class="panel-meta" id="histogramMeta">-</span>
          </div>
          <canvas class="histogram" id="histogram" aria-label="Selected stage distribution"></canvas>

          <div class="panel-heading">
            <span>Weaknesses</span>
            <span class="panel-meta" id="weaknessMeta">-</span>
          </div>
          <div class="weakness-list" id="weaknessList">
            <p class="inspector-empty">Run the unwrap to rank weak charts.</p>
          </div>

          <div class="panel-heading">
            <span>Run settings</span>
            <span class="panel-meta">re-run to apply</span>
          </div>
          <div class="settings-panel" id="settingsPanel">
            <label class="field">
              <span>Unwrap method</span>
              <select id="settingMethod">
                <option value="smart" selected>Smart project</option>
                <option value="lscm">LSCM</option>
              </select>
            </label>
            <label class="field">
              <span>Atlas resolution</span>
              <select id="settingAtlas">
                <option value="512">512 px</option>
                <option value="1024">1024 px</option>
                <option value="2048" selected>2048 px</option>
                <option value="4096">4096 px</option>
              </select>
            </label>
            <label class="field">
              <span>Padding</span>
              <input id="settingPadding" type="number" min="0" max="256" step="1" value="8" />
            </label>
            <label class="field">
              <span>Seam angle</span>
              <input id="settingSeamAngle" type="number" min="0" max="180" step="1" value="66" />
            </label>
            <label class="field">
              <span>Texel density</span>
              <input id="settingDensity" type="number" min="1" max="8192" step="1" value="256" />
            </label>
            <label class="toggle-control field-toggle">
              <input type="checkbox" id="settingRotation" checked />
              <span>Rotate charts 90 deg</span>
            </label>
            <label class="toggle-control field-toggle">
              <input type="checkbox" id="settingFitAtlas" checked />
              <span>Fill atlas</span>
            </label>
            <label class="toggle-control field-toggle">
              <input type="checkbox" id="settingSplitObject" checked />
              <span>Split by object</span>
            </label>
            <button class="button button-quiet button-compact" id="resetSettings" type="button">Reset defaults</button>
          </div>
        </aside>
      </main>

      <input id="modelFileInput" class="file-input-hidden" type="file" accept=".fbx,.obj,.gltf,.glb,.usdz" multiple />
      <div class="drop-overlay" id="dropOverlay" hidden><span>Drop model bundle</span></div>
      <div class="toast" id="toast" hidden></div>
    </div>
  `;
}
