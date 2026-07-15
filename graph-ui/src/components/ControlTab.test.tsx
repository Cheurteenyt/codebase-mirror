import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: number, message: string) { super(message); }
  },
  api: {
    getProcesses: vi.fn().mockResolvedValue({ processes: [] }),
    getLogs: vi.fn().mockResolvedValue({ lines: [] }),
    getIndexStatus: vi.fn().mockResolvedValue({ jobs: [] }),
    terminateIndexJob: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

import { ControlTab } from './ControlTab';

describe('ControlTab owned index-job termination', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import('../api/client');
    (api.getProcesses as ReturnType<typeof vi.fn>).mockResolvedValue({ processes: [] });
    (api.getLogs as ReturnType<typeof vi.fn>).mockResolvedValue({ lines: [] });
  });

  it('does not terminate when confirmation is dismissed', async () => {
    const { api } = await import('../api/client');
    (api.getIndexStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobs: [{ id: 'idx-1234', status: 'running', started_at: 'now', project: 'demo' }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { findByText } = render(<ControlTab />);
    fireEvent.click(await findByText('Terminate'));

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('idx-1234'));
    expect(api.terminateIndexJob).not.toHaveBeenCalled();
  });

  it('terminates the job by ID after confirmation', async () => {
    const { api } = await import('../api/client');
    (api.getIndexStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      jobs: [{ id: 'idx-4321', status: 'running', started_at: 'now', project: 'demo' }],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { findByText } = render(<ControlTab />);
    fireEvent.click(await findByText('Terminate'));

    await waitFor(() => expect(api.terminateIndexJob).toHaveBeenCalledWith('idx-4321'));
  });
});
