// The partner console's routes (docs/batch-c-spec.md "Console BFF routes"). Client-only: the Worker serves index.html
// for every path that isn't an asset or `/api/*`.
import { Route, Routes } from 'react-router-dom';
import { ActionPage } from './pages/Action.tsx';
import { AppPage, AppsList } from './pages/Apps.tsx';
import { Audit } from './pages/Audit.tsx';
import { CancelChange, CancelOwner } from './pages/Cancel.tsx';
import { Members } from './pages/Members.tsx';
import { ScopePage } from './pages/Scope.tsx';
import { Framed, Home, OrgShell } from './pages/Shell.tsx';
import { Invite, SignIn } from './pages/SignIn.tsx';
import { Users } from './pages/Users.tsx';

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/invite" element={<Invite />} />
      <Route path="/cancel/:changeId" element={<CancelChange />} />
      <Route path="/cancel-owner/:grantId" element={<CancelOwner />} />
      <Route
        path="/actions/:id"
        element={
          <Framed>
            <ActionPage />
          </Framed>
        }
      />
      <Route path="/" element={<Home />} />
      <Route path="/orgs/:org" element={<OrgShell />}>
        <Route index element={<AppsList />} />
        <Route path="apps/:app" element={<AppPage />} />
        <Route path="scopes/:scope" element={<ScopePage />} />
        <Route path="members" element={<Members />} />
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
