import React from 'react';
import { UserCard } from './components/UserCard';
import { useUser } from './hooks/useUser';

export function App() {
  const { user, loading } = useUser('123');

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <main>
      <h1>User Dashboard</h1>
      {user && <UserCard user={user} />}
    </main>
  );
}

export default App;

