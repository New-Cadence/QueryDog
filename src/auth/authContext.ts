// Who is logged in, shared from AuthGate to the header's logout button.
import { createContext, useContext } from 'react';

export interface AuthState {
  authEnabled: boolean;
  user: string | null;
  logout: () => void;
}

export const AuthContext = createContext<AuthState>({ authEnabled: false, user: null, logout: () => {} });

export const useAuth = () => useContext(AuthContext);
