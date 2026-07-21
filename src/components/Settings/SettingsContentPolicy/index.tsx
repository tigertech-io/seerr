import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

type PolicyStatus = {
  mode: 'audit' | 'enforce';
  policyVersion: string;
  policyHash: string;
  healthy: boolean;
  loadError?: string;
  counts: {
    allow: number;
    deny: number;
    review: number;
    activeOverrides: number;
  };
};

type PolicyDecision = {
  id: number;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  result: 'allow' | 'deny' | 'review';
  matchedRuleIds: string[];
  categories: string[];
  reviewState: string;
  updatedAt: string;
};

type DecisionResponse = { results: PolicyDecision[]; totalResults: number };

const SettingsContentPolicy = () => {
  const { addToast } = useToasts();
  const router = useRouter();
  const { data: status, mutate: refreshStatus } = useSWR<PolicyStatus>(
    '/api/v1/content-policy/status',
    { refreshInterval: 15000 }
  );
  const { data: decisions, mutate: refreshDecisions } =
    useSWR<DecisionResponse>('/api/v1/content-policy/decisions?size=50');
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>('movie');
  const [tmdbId, setTmdbId] = useState('');
  const [action, setAction] = useState<'create' | 'approve' | 'retry'>(
    'create'
  );
  const [reason, setReason] = useState('');
  const [overrideToken, setOverrideToken] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (router.query.mediaType === 'movie' || router.query.mediaType === 'tv') {
      setMediaType(router.query.mediaType);
    }
    if (typeof router.query.tmdbId === 'string') setTmdbId(router.query.tmdbId);
    if (
      router.query.action === 'create' ||
      router.query.action === 'approve' ||
      router.query.action === 'retry'
    ) {
      setAction(router.query.action);
    }
  }, [router.query]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await operation();
      addToast(success, { appearance: 'success', autoDismiss: true });
      await Promise.all([refreshStatus(), refreshDecisions()]);
    } catch (error) {
      addToast(
        axios.isAxiosError(error)
          ? (error.response?.data?.message ?? error.message)
          : String(error),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setBusy(false);
    }
  };

  if (!status || !decisions) return <LoadingSpinner />;

  return (
    <>
      <PageTitle title="Content Policy" />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold">Content Policy</h2>
          <p className="mt-1 text-sm text-gray-400">
            Canonical rules are repository-managed. Reviews and break-glass
            actions never edit the policy.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              run(
                () => axios.post('/api/v1/content-policy/reload'),
                'Policy reloaded.'
              )
            }
          >
            Reload policy
          </Button>
          <Button
            buttonType="primary"
            disabled={busy}
            onClick={() =>
              run(
                () => axios.post('/api/v1/content-policy/scans'),
                'Read-only library audit completed.'
              )
            }
          >
            Run library audit
          </Button>
        </div>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Mode</div>
          <Badge badgeType={status.mode === 'audit' ? 'warning' : 'danger'}>
            {status.mode}
          </Badge>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Engine</div>
          <Badge badgeType={status.healthy ? 'success' : 'danger'}>
            {status.healthy ? 'healthy' : 'failed'}
          </Badge>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Allowed</div>
          <div className="text-2xl">{status.counts.allow}</div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Denied</div>
          <div className="text-2xl">{status.counts.deny}</div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Review</div>
          <div className="text-2xl">{status.counts.review}</div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Overrides</div>
          <div className="text-2xl">{status.counts.activeOverrides}</div>
        </div>
      </div>

      <div className="mb-8 rounded-lg bg-gray-800 p-5">
        <div className="font-semibold">Policy identity</div>
        <div className="mt-2 break-all font-mono text-sm text-gray-300">
          {status.policyVersion} / {status.policyHash}
        </div>
        {status.loadError && (
          <div className="mt-2 text-red-400">{status.loadError}</div>
        )}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg bg-gray-800 p-5">
          <h3 className="mb-4 text-lg font-semibold">On-demand evaluation</h3>
          <div className="flex flex-wrap gap-3">
            <select
              className="rounded bg-gray-700 px-3 py-2"
              value={mediaType}
              onChange={(event) =>
                setMediaType(event.target.value as 'movie' | 'tv')
              }
            >
              <option value="movie">Movie</option>
              <option value="tv">Series</option>
            </select>
            <input
              className="rounded bg-gray-700 px-3 py-2"
              inputMode="numeric"
              placeholder="TMDB ID"
              value={tmdbId}
              onChange={(event) => setTmdbId(event.target.value)}
            />
            <Button
              buttonType="primary"
              disabled={busy || !Number(tmdbId)}
              onClick={() =>
                run(
                  () =>
                    axios.post('/api/v1/content-policy/evaluate', {
                      mediaType,
                      tmdbId: Number(tmdbId),
                    }),
                  'Evaluation recorded.'
                )
              }
            >
              Evaluate
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-red-700 bg-gray-800 p-5">
          <h3 className="mb-1 text-lg font-semibold">Break glass</h3>
          <p className="mb-4 text-sm text-gray-400">
            Issues a one-action token that expires after 15 minutes and is
            consumed atomically.
          </p>
          <div className="flex flex-wrap gap-3">
            <select
              className="rounded bg-gray-700 px-3 py-2"
              value={action}
              onChange={(event) =>
                setAction(event.target.value as typeof action)
              }
            >
              <option value="create">Create</option>
              <option value="approve">Approve</option>
              <option value="retry">Retry</option>
            </select>
            <input
              className="min-w-72 flex-1 rounded bg-gray-700 px-3 py-2"
              placeholder="Mandatory reason (at least 20 characters)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              buttonType="danger"
              disabled={busy || !Number(tmdbId) || reason.trim().length < 20}
              onClick={() =>
                run(async () => {
                  const response = await axios.post(
                    '/api/v1/content-policy/break-glass',
                    { mediaType, tmdbId: Number(tmdbId), action, reason }
                  );
                  setOverrideToken(response.data.token);
                }, 'Break-glass token issued.')
              }
            >
              Issue token
            </Button>
          </div>
          {overrideToken && (
            <div className="mt-4 rounded bg-gray-900 p-3">
              <div className="text-xs text-yellow-300">
                Copy now; the token is never shown again.
              </div>
              <code className="break-all text-xs">{overrideToken}</code>
            </div>
          )}
        </section>
      </div>

      <section className="rounded-lg bg-gray-800 p-5">
        <h3 className="mb-4 text-lg font-semibold">
          Recent decisions ({decisions.totalResults})
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-400">
              <tr>
                <th className="p-2">Media</th>
                <th className="p-2">Decision</th>
                <th className="p-2">Categories / rules</th>
                <th className="p-2">Review</th>
                <th className="p-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {decisions.results.map((decision) => (
                <tr
                  key={decision.id}
                  className="border-t border-gray-700 align-top"
                >
                  <td className="p-2 font-mono">
                    {decision.mediaType}:{decision.tmdbId}
                  </td>
                  <td className="p-2">
                    <Badge
                      badgeType={
                        decision.result === 'allow'
                          ? 'success'
                          : decision.result === 'deny'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {decision.result}
                    </Badge>
                  </td>
                  <td className="p-2">
                    <div>{decision.categories.join(', ') || 'none'}</div>
                    <div className="font-mono text-xs text-gray-500">
                      {decision.matchedRuleIds.join(', ')}
                    </div>
                  </td>
                  <td className="p-2">
                    {decision.result === 'review' &&
                    decision.reviewState !== 'acknowledged' ? (
                      <div className="flex gap-2">
                        <input
                          className="rounded bg-gray-700 px-2 py-1"
                          placeholder="Review note"
                          value={reviewNote}
                          onChange={(event) =>
                            setReviewNote(event.target.value)
                          }
                        />
                        <Button
                          buttonSize="sm"
                          disabled={!reviewNote.trim()}
                          onClick={() =>
                            run(
                              () =>
                                axios.post(
                                  `/api/v1/content-policy/decisions/${decision.id}/acknowledge`,
                                  { note: reviewNote }
                                ),
                              'Review acknowledged; media remains blocked.'
                            )
                          }
                        >
                          Acknowledge
                        </Button>
                      </div>
                    ) : (
                      decision.reviewState
                    )}
                  </td>
                  <td className="p-2 text-gray-400">
                    {new Date(decision.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
};

export default SettingsContentPolicy;
