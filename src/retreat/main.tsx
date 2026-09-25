import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RetreatApp from './RetreatApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RetreatApp />
  </StrictMode>,
);
