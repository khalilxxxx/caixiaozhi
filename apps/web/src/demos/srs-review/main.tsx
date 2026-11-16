import React from 'react';
import { createRoot } from 'react-dom/client';
import { SrsReviewDemo } from './SrsReviewDemo.js';
import './srs-review.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SrsReviewDemo />
  </React.StrictMode>,
);
