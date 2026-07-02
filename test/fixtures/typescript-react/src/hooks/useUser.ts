import { useEffect, useState } from 'react';
import type { User } from '../components/UserCard';

export function useUser(id: string) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUser(id).then((loadedUser) => {
      setUser(loadedUser);
      setLoading(false);
    });
  }, [id]);

  return { user, loading };
}

export async function loadUser(id: string): Promise<User> {
  return { id, name: 'Ada Lovelace', email: 'ada@example.com' };
}

