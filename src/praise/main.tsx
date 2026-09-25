import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PraiseApp from './PraiseApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PraiseApp />
  </StrictMode>,
);
