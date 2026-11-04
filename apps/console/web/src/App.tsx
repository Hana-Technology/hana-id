// The partner console's routes (docs/batch-c-spec.md "Console BFF routes"). Client-only: the Worker serves index.html
// for every path that isn't an asset or `/api/*`.
import { Route, Routes } from 'react-router-dom';
import { AppPage, AppsList } from './pages/Apps.tsx';
import { Audit } from './pages/Audit.tsx';
import { Members } from './pages/Members.tsx';
import { Home, OrgShell } from './pages/Shell.tsx';
import { Invite, SignIn } from './pages/SignIn.tsx';

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/invite" element={<Invite />} />
      <Route path="/" element={<Home />} />
      <Route path="/orgs/:org" element={<OrgShell />}>
        <Route index element={<AppsList />} />
        <Route path="apps/:app" element={<AppPage />} />
        <Route path="members" element={<Members />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
