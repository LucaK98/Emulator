import { render } from 'preact';
import { App } from './app/App';
import './app/styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point missing');

render(<App />, root);
