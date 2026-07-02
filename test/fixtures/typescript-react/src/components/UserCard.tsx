import React from 'react';

export interface User {
  id: string;
  name: string;
  email: string;
}

export function UserCard({ user }: { user: User }) {
  return (
    <article className="user-card">
      <h2>{user.name}</h2>
      <p>{user.email}</p>
    </article>
  );
}

