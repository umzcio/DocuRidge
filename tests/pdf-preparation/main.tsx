import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { NewEnvelopeForm } from '../../src/app/dashboard/envelopes/new/form';
import '../../src/app/globals.css';

createRoot(document.getElementById('root')!).render(<><NewEnvelopeForm /><Toaster /></>);
