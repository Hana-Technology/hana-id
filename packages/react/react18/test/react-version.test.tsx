// @vitest-environment happy-dom
// This suite really runs on React 18: the package's tests (../../test) import the same `react`, `react-dom` and
// @testing-library/react as these checks.
import { render } from '@testing-library/react';
import { version } from 'react';
import { version as domVersion } from 'react-dom';
import { describe, expect, it } from 'vitest';
import { HanaContext } from '../../src/index.ts';

describe('React 18', () => {
  it('react and react-dom are 18.3.1', () => {
    expect(version).toBe('18.3.1');
    expect(domVersion).toBe('18.3.1');
  });

  it("the package's source renders with this React (one React instance)", () => {
    const view = render(<HanaContext.Consumer>{(v) => <p>{v === null ? 'outside' : 'inside'}</p>}</HanaContext.Consumer>);
    expect(view.container.textContent).toBe('outside');
    view.unmount();
  });
});
