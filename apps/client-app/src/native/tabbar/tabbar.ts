import { tauriBackend } from './backend.js';
import { mountTabbar } from './page.js';
import './tabbar.css';

const root = document.getElementById('root');
if (root) void mountTabbar(root, tauriBackend);
