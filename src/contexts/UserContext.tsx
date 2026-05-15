import React, { createContext, useContext, useState } from "react";
import { getAnonymousUserId } from "../utils/anonymousUser";

interface UserContextType {
  anonymousId: string;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const [anonymousId] = useState<string>(getAnonymousUserId());

  return (
    <UserContext.Provider value={{ anonymousId }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) throw new Error("useUser must be used within a UserProvider");
  return context;
}
