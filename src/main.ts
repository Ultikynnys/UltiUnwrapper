import './style.css';
import { App } from './ui/app';
import { renderShell } from './ui/shell';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Application root not found.');

renderShell(root);
new App();
