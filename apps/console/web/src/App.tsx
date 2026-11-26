// The partner console's routes (docs/batch-c-spec.md "Console BFF routes"). Client-only: the Worker serves index.html
// for every path that isn't an asset or `/api/*`. An app's sections are nested routes under `/orgs/:org/apps/:app`
// (its overview is the app's own URL, as before). Every page shares one toast stack (toast.tsx).
import { Suspense, lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ActionPage } from './pages/Action.tsx';
import { AppLayout, AppsList } from './pages/Apps.tsx';
import { Branding } from './pages/app/Branding.tsx';
import { Keys } from './pages/app/Keys.tsx';
import { Origins } from './pages/app/Origins.tsx';
import { Overview } from './pages/app/Overview.tsx';
import { EmailLogin } from './pages/app/EmailLogin.tsx';
import { Sessions } from './pages/app/Sessions.tsx';
import { Signing } from './pages/app/Signing.tsx';
import { Suspend } from './pages/app/Suspend.tsx';
import { Audit } from './pages/Audit.tsx';
import { CancelChange, CancelOwner, CancelPlatformKey, RevokePlatformKey } from './pages/Cancel.tsx';
import { ConfirmOrigins, FindConfirmation } from './pages/ConfirmOrigins.tsx';
import { ConfirmPlatformKey, PlatformKeyPage, PlatformKeys } from './pages/PlatformKeys.tsx';
import { PlatformActivity } from './pages/PlatformActivity.tsx';
import { Members } from './pages/Members.tsx';
import { RemoveOrigin } from './pages/RemoveOrigin.tsx';
import { ScopePage } from './pages/Scope.tsx';
import { StatementPage, Statements } from './pages/Statements.tsx';
import { Framed, Home, OrgShell } from './pages/Shell.tsx';
import { Invite, SignIn } from './pages/SignIn.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Upgrades } from './pages/Upgrades.tsx';
import { Usage } from './pages/Usage.tsx';
import { Users } from './pages/Users.tsx';
import { ToastProvider } from './toast.tsx';
import { Loading } from './ui.tsx';

/**
 * The Request labels tab (D899) is its own chunk: it carries Journear's decoder, the Stellar SDK and the approval
 * window's renderer for its preview, which no other page needs.
 */
const Labels = lazy(() => import('./pages/app/Labels.tsx').then((m) => ({ default: m.Labels })));
const labels = (
  <Suspense fallback={<Loading />}>
    <Labels />
  </Suspense>
);

export function App() {
  return (
    <ToastProvider>
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/invite" element={<Invite />} />
      <Route path="/cancel/:changeId" element={<CancelChange />} />
      <Route path="/cancel-owner/:grantId" element={<CancelOwner />} />
      <Route path="/cancel-platform-key/:keyId" element={<CancelPlatformKey />} />
      <Route path="/revoke-platform-key/:keyId" element={<RevokePlatformKey />} />
      <Route path="/confirm-platform-key/:keyId" element={<Framed>{() => <ConfirmPlatformKey />}</Framed>} />
      {/* D931: the email's Confirm link (finds the org, then the page below) and the confirmation notice's removal link. */}
      <Route path="/confirm/:changeId" element={<FindConfirmation />} />
      <Route path="/remove/:changeId" element={<RemoveOrigin />} />
      <Route path="/actions/:id" element={<Framed>{(me) => <ActionPage me={me} />}</Framed>} />
      <Route path="/" element={<Home />} />
      <Route path="/orgs/:org" element={<OrgShell />}>
        <Route index element={<AppsList />} />
        <Route path="apps/:app" element={<AppLayout />}>
          <Route index element={<Overview />} />
          <Route path="origins" element={<Origins />} />
          <Route path="keys" element={<Keys />} />
          <Route path="sessions" element={<Sessions />} />
          <Route path="email" element={<EmailLogin />} />
          <Route path="signing" element={<Signing />} />
          <Route path="labels" element={labels} />
          <Route path="labels/:labelId" element={labels} />
          <Route path="branding" element={<Branding />} />
          <Route path="suspend" element={<Suspend />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="apps/:app/confirm/:changeId" element={<ConfirmOrigins />} />
        <Route path="scopes/:scope" element={<ScopePage />} />
        <Route path="members" element={<Members />} />
        <Route path="platform-keys" element={<PlatformKeys />} />
        <Route path="platform-keys/:keyId" element={<PlatformKeyPage />} />
        <Route path="platform-activity" element={<PlatformActivity />} />
        <Route path="usage" element={<Usage />} />
        <Route path="statements" element={<Statements />} />
        <Route path="statements/:month" element={<StatementPage />} />
        <Route path="upgrades" element={<Upgrades />} />
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
    </ToastProvider>
  );
}
