// Type-checked (not run) with types.ts: @hana-id/react's JSX types under the partner's @types/react.
import { HanaProvider, useHana } from '@hana-id/react';
import type { ReactElement } from 'react';

function SignIn(): ReactElement {
  const { status, login } = useHana();
  return <button onClick={login}>{status === 'logged_in' ? 'Signed in' : 'Sign in'}</button>;
}

export function App(): ReactElement {
  return (
    <HanaProvider config={{ publishableKey: 'pk_test_example', environment: 'sandbox-dev' }}>
      <SignIn />
    </HanaProvider>
  );
}
