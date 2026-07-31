import csurf from '@dr.pogodin/csurf';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import ContentPolicyDecision from '@server/entity/ContentPolicyDecision';
import ContentPolicyEvent from '@server/entity/ContentPolicyEvent';
import { getContentPolicyEvaluator } from '@server/lib/contentPolicy';
import { runContentPolicyLibraryAudit } from '@server/lib/contentPolicy/audit';
import { isRetirableMetadataFailureDecision } from '@server/lib/contentPolicy/retirement';
import { Router } from 'express';

const routes = Router();
const evaluator = getContentPolicyEvaluator();
const secureCsrfCookie = process.env.NODE_ENV !== 'development';

// Seerr's global CSRF middleware uses the `_csrf` cookie as its secret. The
// policy router deliberately adds its own always-on guard, but it must reuse
// that cookie contract so a token issued by the global middleware validates at
// both layers.
routes.use(
  csurf({
    cookie: {
      httpOnly: true,
      sameSite: true,
      secure: secureCsrfCookie,
      key: '_csrf',
      path: '/',
    },
  })
);
routes.use((req, res, next) => {
  res.cookie('XSRF-TOKEN', req.csrfToken(), {
    httpOnly: false,
    sameSite: true,
    secure: secureCsrfCookie,
  });
  next();
});

const requireInteractiveAdministrator: Middleware = (req, res, next) => {
  if (req.header('X-API-Key') || !req.session?.userId || !req.user) {
    res.status(403).json({
      status: 403,
      error: 'An interactive administrator session is required.',
    });
    return;
  }
  next();
};

const pageOptions = (req: Parameters<Middleware>[0]) => ({
  page: Math.max(1, Number(req.query.page ?? 1)),
  size: Math.min(100, Math.max(1, Number(req.query.size ?? 25))),
});

routes.get('/status', async (_req, res, next) => {
  try {
    return res.json(await evaluator.status());
  } catch (error) {
    next({
      status: 503,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

routes.get('/decisions', async (req, res, next) => {
  try {
    const { page, size } = pageOptions(req);
    const query = getRepository(ContentPolicyDecision)
      .createQueryBuilder('decision')
      .orderBy('decision.updatedAt', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    if (typeof req.query.result === 'string') {
      query.andWhere('decision.result = :result', { result: req.query.result });
    }
    if (typeof req.query.mediaType === 'string') {
      query.andWhere('decision.mediaType = :mediaType', {
        mediaType: req.query.mediaType,
      });
    }
    const [results, total] = await query.getManyAndCount();
    return res.json({ page, pageSize: size, totalResults: total, results });
  } catch (error) {
    next({
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

routes.get('/decisions/:mediaType/:tmdbId', async (req, res, next) => {
  try {
    const decision = await getRepository(ContentPolicyDecision).findOneOrFail({
      where: {
        mediaType: req.params.mediaType as MediaType,
        tmdbId: Number(req.params.tmdbId),
      },
    });
    const manualDenySnippet = [
      'manualDeny:',
      `  ${decision.mediaType === MediaType.MOVIE ? 'movie' : 'tv'}:`,
      `    - ${decision.tmdbId}`,
    ].join('\n');
    return res.json({ ...decision, manualDenySnippet });
  } catch {
    next({ status: 404, message: 'Policy decision not found.' });
  }
});

routes.get('/events', async (req, res, next) => {
  try {
    const { page, size } = pageOptions(req);
    const query = getRepository(ContentPolicyEvent)
      .createQueryBuilder('event')
      .orderBy('event.createdAt', 'DESC')
      .skip((page - 1) * size)
      .take(size);
    if (typeof req.query.eventType === 'string') {
      query.andWhere('event.eventType = :eventType', {
        eventType: req.query.eventType,
      });
    }
    const [results, total] = await query.getManyAndCount();
    return res.json({ page, pageSize: size, totalResults: total, results });
  } catch (error) {
    next({
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

routes.post(
  '/evaluate',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      const mediaType = req.body.mediaType as MediaType;
      if (![MediaType.MOVIE, MediaType.TV].includes(mediaType)) {
        return res
          .status(400)
          .json({ error: 'mediaType must be movie or tv.' });
      }
      return res.json(
        await evaluator.evaluate(mediaType, Number(req.body.tmdbId), {
          actorUserId: req.user?.id,
          source: 'admin-evaluate',
          force: true,
        })
      );
    } catch (error) {
      next({
        status: 503,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

routes.post(
  '/reload',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      await evaluator.reload(req.user?.id);
      return res.json(await evaluator.status());
    } catch (error) {
      next({
        status: 400,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

routes.post(
  '/decisions/:id/acknowledge',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      const note = String(req.body.note ?? '').trim();
      if (!note)
        return res.status(400).json({ error: 'A review note is required.' });
      const repository = getRepository(ContentPolicyDecision);
      const decision = await repository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });
      decision.reviewState = 'acknowledged';
      decision.reviewNote = note;
      decision.reviewedById = req.user?.id;
      decision.reviewedAt = new Date();
      await repository.save(decision);
      await evaluator.recordEvent('review_acknowledged', {
        mediaType: decision.mediaType,
        tmdbId: decision.tmdbId,
        actorUserId: req.user?.id,
        decisionId: decision.id,
        details: { noteLength: note.length },
      });
      return res.json(decision);
    } catch (error) {
      next({
        status: 404,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

routes.post(
  '/decisions/:id/retire-metadata-failure',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      const repository = getRepository(ContentPolicyDecision);
      const decision = await repository.findOne({
        where: { id: Number(req.params.id) },
      });
      if (!decision) {
        return res
          .status(404)
          .json({ status: 404, message: 'Policy decision not found.' });
      }
      if (!isRetirableMetadataFailureDecision(decision)) {
        return res.status(409).json({
          status: 409,
          message:
            'Only source-isolated metadata-failure reviews can be retired.',
        });
      }

      const retired = {
        id: decision.id,
        mediaType: decision.mediaType,
        tmdbId: decision.tmdbId,
        sourceMemberships: decision.sourceMemberships,
      };
      await repository.manager.transaction(async (manager) => {
        await manager.remove(decision);
        await manager.save(
          new ContentPolicyEvent({
            eventType: 'metadata_failure_decision_retired',
            mediaType: retired.mediaType,
            tmdbId: retired.tmdbId,
            actorUserId: req.user?.id,
            policyVersion: decision.policyVersion,
            policyHash: decision.policyHash,
            details: {
              retiredDecisionId: retired.id,
              sourceMemberships: retired.sourceMemberships,
            },
          })
        );
      });
      return res.json({
        retired: true,
        mediaType: retired.mediaType,
        tmdbId: retired.tmdbId,
      });
    } catch (error) {
      next({
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

routes.post(
  '/break-glass',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      const result = await evaluator.issueOverride({
        administratorId: req.user?.id as number,
        mediaType: req.body.mediaType as MediaType,
        tmdbId: Number(req.body.tmdbId),
        action: req.body.action,
        reason: String(req.body.reason ?? ''),
      });
      return res.status(201).json({
        token: result.token,
        overrideId: result.override.id,
        expiresAt: result.override.expiresAt,
        mediaType: result.override.mediaType,
        tmdbId: result.override.tmdbId,
        action: result.override.action,
      });
    } catch (error) {
      next({
        status: 400,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

routes.post(
  '/scans',
  requireInteractiveAdministrator,
  async (req, res, next) => {
    try {
      return res
        .status(202)
        .json(await runContentPolicyLibraryAudit(req.user?.id));
    } catch (error) {
      await evaluator.recordEvent('library_scan_failed', {
        actorUserId: req.user?.id,
        details: { error: error instanceof Error ? error.name : 'unknown' },
      });
      next({
        status: 503,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

export default routes;
