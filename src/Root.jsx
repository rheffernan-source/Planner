import React from 'react';
import App from './App';

export default function Root() {
  return (
    <div className="h-screen w-full flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0">
        <App />
      </div>
    </div>
  );
}
