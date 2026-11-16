import React from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentQueryDemo } from './DocumentQueryDemo.js';
import './document-query.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DocumentQueryDemo />
  </React.StrictMode>,
);
