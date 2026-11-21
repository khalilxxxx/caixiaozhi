import { createRoot } from 'react-dom/client';
import App from './App';
import { WorkDocumentSource } from './WorkDocumentSource';
import { ProgressDocumentSource } from './ProgressDocumentSource';
import './styles.css';
import './enterprise-theme.css';
import './home.css';

const params = new URLSearchParams(location.search);
const sourceId = params.get('source-document');
const progressKey = params.get('progress-source');
const page =
  sourceId !== null ? (
    <WorkDocumentSource
      id={sourceId}
      progressKey={params.get('progress-key')}
      sourceSystem={params.get('source-system')}
    />
  ) : progressKey !== null ? (
    <ProgressDocumentSource recordKey={progressKey} />
  ) : (
    <App />
  );
createRoot(document.getElementById('root')!).render(page);
