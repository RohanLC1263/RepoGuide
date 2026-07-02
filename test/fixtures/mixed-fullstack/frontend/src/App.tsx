import React, { useEffect, useState } from 'react';

type Order = {
  id: number;
  status: string;
};

async function fetchOrder(id: number): Promise<Order> {
  const response = await fetch(`/api/orders/${id}`);
  return response.json();
}

export function App() {
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    fetchOrder(42).then(setOrder);
  }, []);

  return <h1>{order ? `Order ${order.status}` : 'Loading order'}</h1>;
}

