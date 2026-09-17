import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import WednesdayApp from './WednesdayApp';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WednesdayApp />
  </StrictMode>,
);
