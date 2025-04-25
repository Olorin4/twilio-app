/* main.jsx is the React app entry point */

import React from 'react';
import ReactDOM from 'react-dom/client';
import VoipApp from './VoipApp.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <VoipApp />
  </React.StrictMode>
);
