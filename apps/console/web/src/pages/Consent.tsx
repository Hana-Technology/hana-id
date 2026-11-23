// The consent preview (ConsentView.tsx: the Hana popup's own renderConsent, D352), in a chunk of its own with the
// approval window's code it shares (render-approval.ts and Journear's decoders), so the console's first page doesn't
// carry it (D899: the Request labels preview loads the same code).
import { type ComponentProps, Suspense, lazy } from 'react';
import { Loading } from '../ui.tsx';

const View = lazy(() => import('./ConsentView.tsx'));

export function ConsentPreview(props: ComponentProps<typeof View>) {
  return (
    <Suspense fallback={<Loading label="Loading the preview…" />}>
      <View {...props} />
    </Suspense>
  );
}
