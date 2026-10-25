import React from 'react';
import { SettingsProvider } from './SettingsContext';
import { ModelsProvider } from './ModelsContext';
import { SubtitleDocumentProvider } from './SubtitleDocumentContext';
import { ProgressProvider } from './ProgressContext';
import { ErrorDialogProvider } from './ErrorDialogContext';
import { IntegrationProvider } from './IntegrationContext';
import { AudioPreviewProvider } from './AudioPreviewContext';

import { AdobeProvider } from './AdobeContext';

interface GlobalProviderProps {
  children: React.ReactNode;
}

interface EditorWorkspaceProvidersProps {
  children: React.ReactNode;
}

/**
 * GlobalProvider - Composition wrapper that nests all context providers
 * 
 * Root provider nesting order (from outermost to innermost):
 * 1. SettingsProvider - Core settings and persistence (leaf context)
 * 2. ModelsProvider - Model management (depends on settings)
 * 3. IntegrationProvider - The host app (Premiere Pro)
 * 
 * Editor-specific providers are mounted by EditorWorkspaceProviders, closer to
 * the UI that actually needs host app state, subtitle document state, and progress.
 */
export function GlobalProvider({ children }: GlobalProviderProps) {
  // ErrorDialogProvider is mounted at the outermost layer so any inner
  // provider or component (transcription, Premiere calls, etc.) can reach the
  // single app-wide error dialog via `useErrorDialog()`.
  return (
    <ErrorDialogProvider>
      <SettingsProvider>
        <ModelsProvider>
          <IntegrationProvider>
            {children}
          </IntegrationProvider>
        </ModelsProvider>
      </SettingsProvider>
    </ErrorDialogProvider>
  );
}

export function EditorWorkspaceProviders({ children }: EditorWorkspaceProvidersProps) {
  return (
    <AdobeProvider>
      <AudioPreviewProvider>
        <SubtitleDocumentProvider>
          <ProgressProvider>
            {children}
          </ProgressProvider>
        </SubtitleDocumentProvider>
      </AudioPreviewProvider>
    </AdobeProvider>
  );
}

