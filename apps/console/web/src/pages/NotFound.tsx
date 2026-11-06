// An unknown page inside an organisation: say so and offer the way back (top-level unknown paths go to Home).
import { Link, useParams } from 'react-router-dom';
import { Empty } from '../ui.tsx';

export function NotFound() {
  const { org } = useParams();
  return (
    <Empty title="There’s no page here">
      <p>
        The link may be mistyped or out of date. <Link to={`/orgs/${org}`}>Go to your apps</Link>
      </p>
    </Empty>
  );
}
