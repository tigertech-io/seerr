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
    failures: number;
    libraryFindings: number;
    breakGlassEvents: number;
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
  evidence?: Record<string, unknown>;
  sourceMemberships?: string[];
  reviewState: string;
  updatedAt: string;
  manualDenySnippet?: string;
};

type DecisionResponse = { results: PolicyDecision[]; totalResults: number };
type PolicyEvent = {
  id: number;
  eventType: string;
  mediaType?: 'movie' | 'tv';
  tmdbId?: number;
  details: Record<string, unknown>;
  createdAt: string;
};
type EventResponse = { results: PolicyEvent[]; totalResults: number };

const SettingsContentPolicy = () => {
  const { addToast } = useToasts();
  const router = useRouter();
  const { data: status, mutate: refreshStatus } = useSWR<PolicyStatus>(
    '/api/v1/content-policy/status',
    { refreshInterval: 15000 }
  );
  const [resultFilter, setResultFilter] = useState('');
  const [mediaFilter, setMediaFilter] = useState('');
  const decisionQuery = new URLSearchParams({ size: '50' });
  if (resultFilter) decisionQuery.set('result', resultFilter);
  if (mediaFilter) decisionQuery.set('mediaType', mediaFilter);
  const { data: decisions, mutate: refreshDecisions } =
    useSWR<DecisionResponse>(
      `/api/v1/content-policy/decisions?${decisionQuery.toString()}`
    );
  const { data: events, mutate: refreshEvents } = useSWR<EventResponse>(
    '/api/v1/content-policy/events?size=50',
    { refreshInterval: 15000 }
  );
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>('movie');
  const [tmdbId, setTmdbId] = useState('');
  const [action, setAction] = useState<'create' | 'approve' | 'retry'>(
    'create'
  );
  const [reason, setReason] = useState('');
  const [overrideToken, setOverrideToken] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [selectedDecision, setSelectedDecision] = useState<PolicyDecision>();
  const [scanSummary, setScanSummary] = useState('');
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
      const result = await operation();
      if (result === false) return;
      addToast(success, { appearance: 'success', autoDismiss: true });
      await Promise.all([refreshStatus(), refreshDecisions(), refreshEvents()]);
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

  if (!status || !decisions || !events) return <LoadingSpinner />;

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
              run(async () => {
                const response = await axios.post(
                  '/api/v1/content-policy/scans'
                );
                setScanSummary(
                  `${response.data.evaluated} evaluated; ${response.data.unresolved} unresolved; read-only confirmed.`
                );
              }, 'Read-only library audit completed.')
            }
          >
            Run library audit
          </Button>
        </div>
      </div>

      {scanSummary && (
        <div className="mb-6 rounded border border-indigo-500 bg-gray-800 p-3 text-sm">
          Last on-demand scan: {scanSummary}
        </div>
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-9">
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
          <div className="text-xs text-gray-400">Failures</div>
          <div className="text-2xl">{status.counts.failures}</div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Library findings</div>
          <div className="text-2xl">{status.counts.libraryFindings}</div>
        </div>
        <div className="rounded-lg bg-gray-800 p-4">
          <div className="text-xs text-gray-400">Break-glass events</div>
          <div className="text-2xl">{status.counts.breakGlassEvents}</div>
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
                  const confirmed = window.confirm(
                    `Issue one ${action} override for ${mediaType}:${tmdbId}? It expires 15 minutes after issuance.\n\nReason: ${reason.trim()}`
                  );
                  if (!confirmed) return false;
                  const response = await axios.post(
                    '/api/v1/content-policy/break-glass',
                    { mediaType, tmdbId: Number(tmdbId), action, reason }
                  );
                  setOverrideToken(response.data.token);
                  return true;
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">
            Decisions ({decisions.totalResults})
          </h3>
          <div className="flex gap-2">
            <select
              className="rounded bg-gray-700 px-3 py-2"
              value={mediaFilter}
              onChange={(event) => setMediaFilter(event.target.value)}
            >
              <option value="">All media</option>
              <option value="movie">Movies</option>
              <option value="tv">Series</option>
            </select>
            <select
              className="rounded bg-gray-700 px-3 py-2"
              value={resultFilter}
              onChange={(event) => setResultFilter(event.target.value)}
            >
              <option value="">All decisions</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
              <option value="review">Review</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-400">
              <tr>
                <th className="p-2">Media</th>
                <th className="p-2">Decision</th>
                <th className="p-2">Categories / rules</th>
                <th className="p-2">Review</th>
                <th className="p-2">Updated</th>
                <th className="p-2">Evidence</th>
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
                  <td className="p-2">
                    <Button
                      buttonSize="sm"
                      onClick={async () => {
                        const response = await axios.get(
                          `/api/v1/content-policy/decisions/${decision.mediaType}/${decision.tmdbId}`
                        );
                        setSelectedDecision(response.data);
                      }}
                    >
                      Inspect
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedDecision && (
        <section className="mt-8 rounded-lg bg-gray-800 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">
              Evidence for {selectedDecision.mediaType}:
              {selectedDecision.tmdbId}
            </h3>
            <Button
              buttonSize="sm"
              onClick={() => setSelectedDecision(undefined)}
            >
              Close
            </Button>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-gray-400">Sources</div>
              <pre className="overflow-x-auto rounded bg-gray-900 p-3 text-xs">
                {JSON.stringify(
                  selectedDecision.sourceMemberships ?? [],
                  null,
                  2
                )}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-400">Matched evidence</div>
              <pre className="overflow-x-auto rounded bg-gray-900 p-3 text-xs">
                {JSON.stringify(selectedDecision.evidence ?? {}, null, 2)}
              </pre>
            </div>
          </div>
          <div className="mt-4">
            <div className="mb-1 text-xs text-gray-400">
              Repository manual-deny snippet
            </div>
            <pre className="overflow-x-auto rounded bg-gray-900 p-3 text-xs">
              {selectedDecision.manualDenySnippet}
            </pre>
          </div>
        </section>
      )}

      <section className="mt-8 rounded-lg bg-gray-800 p-5">
        <h3 className="mb-4 text-lg font-semibold">
          Events, scans, failures, and overrides ({events.totalResults})
        </h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-gray-400">
              <tr>
                <th className="p-2">Time</th>
                <th className="p-2">Event</th>
                <th className="p-2">Media</th>
                <th className="p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.results.map((event) => (
                <tr
                  key={event.id}
                  className="border-t border-gray-700 align-top"
                >
                  <td className="whitespace-nowrap p-2 text-gray-400">
                    {new Date(event.createdAt).toLocaleString()}
                  </td>
                  <td className="p-2 font-mono">{event.eventType}</td>
                  <td className="p-2 font-mono">
                    {event.mediaType && event.tmdbId
                      ? `${event.mediaType}:${event.tmdbId}`
                      : '—'}
                  </td>
                  <td className="p-2">
                    <pre className="max-w-xl overflow-x-auto whitespace-pre-wrap text-xs text-gray-300">
                      {JSON.stringify(event.details)}
                    </pre>
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
