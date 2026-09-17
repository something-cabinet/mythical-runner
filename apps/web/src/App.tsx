import { matchRoute, usePath } from './lib/router';
import { Home } from './screens/Home';
import { Room } from './screens/Room';

export function App() {
  const route = matchRoute(usePath());
  // Keyed by code so moving between rooms tears down the old connection completely.
  return route.name === 'room' ? <Room key={route.code} code={route.code} /> : <Home />;
}
