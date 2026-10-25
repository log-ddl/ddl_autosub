import React, { createContext, useContext } from 'react';

/** The editor AutoSubs talks to. Premiere Pro is the only one left. */
export type Integration = "premiere";

interface IntegrationContextType {
  selectedIntegration: Integration;
}

const IntegrationContext = createContext<IntegrationContextType | null>(null);

const VALUE: IntegrationContextType = { selectedIntegration: "premiere" };

export function IntegrationProvider({ children }: { children: React.ReactNode }) {
  return (
    <IntegrationContext.Provider value={VALUE}>
      {children}
    </IntegrationContext.Provider>
  );
}

export const useIntegration = () => {
  const context = useContext(IntegrationContext);
  if (!context) {
    throw new Error('useIntegration must be used within an IntegrationProvider');
  }
  return context;
};
