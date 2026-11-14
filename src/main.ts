import './style.css';
import { renderShell } from './ui/shell';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Application root not found.');

renderShell(app);
