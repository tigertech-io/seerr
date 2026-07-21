import TheMovieDb from '@server/api/themoviedb';
import Media from '@server/entity/Media';
import { filterContentPolicyPayload } from '@server/lib/contentPolicy/filter';
import { Permission } from '@server/lib/permissions';
import logger from '@server/logger';
import {
  mapCastCredits,
  mapCrewCredits,
  mapPersonDetails,
} from '@server/models/Person';
import { Router } from 'express';

const personRoutes = Router();

personRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const person = await tmdb.getPerson({
      personId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });
    if (person.adult && !req.user?.hasPermission(Permission.ADMIN)) {
      return next({ status: 404, message: 'Person not found.' });
    }
    if (!req.user?.hasPermission(Permission.ADMIN)) {
      const credits = await tmdb.getPersonCombinedCredits({
        personId: Number(req.params.id),
        language: (req.query.language as string) ?? req.locale,
      });
      const filtered = await filterContentPolicyPayload(
        {
          results: [...credits.cast, ...credits.crew]
            .filter((item) => item.media_type)
            .map((item) => ({ ...item, mediaType: item.media_type })),
        },
        req.user
      );
      if (!filtered.results.length) {
        return next({ status: 404, message: 'Person not found.' });
      }
    }
    return res.status(200).json(mapPersonDetails(person));
  } catch (e) {
    logger.debug('Something went wrong retrieving person', {
      label: 'API',
      errorMessage: e.message,
      personId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve person.',
    });
  }
});

personRoutes.get('/:id/combined_credits', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const combinedCredits = await tmdb.getPersonCombinedCredits({
      personId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });

    const castMedia = await Media.getRelatedMedia(
      req.user,
      combinedCredits.cast
        .filter((result) => result.media_type)
        .map((result) => ({
          tmdbId: result.id,
          mediaType: result.media_type!,
        }))
    );

    const crewMedia = await Media.getRelatedMedia(
      req.user,
      combinedCredits.crew
        .filter((result) => result.media_type)
        .map((result) => ({
          tmdbId: result.id,
          mediaType: result.media_type!,
        }))
    );

    const cast = combinedCredits.cast
      .map((result) =>
        mapCastCredits(
          result,
          castMedia.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === result.media_type
          )
        )
      )
      .filter((item) => !item.adult && item.character !== 'Thanks');
    const crew = combinedCredits.crew
      .map((result) =>
        mapCrewCredits(
          result,
          crewMedia.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === result.media_type
          )
        )
      )
      .filter((item) => !item.adult && item.job !== 'Thanks');
    const [filteredCast, filteredCrew] = await Promise.all([
      filterContentPolicyPayload({ results: cast }, req.user),
      filterContentPolicyPayload({ results: crew }, req.user),
    ]);
    return res.status(200).json({
      cast: filteredCast.results,
      crew: filteredCrew.results,
      id: combinedCredits.id,
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving combined credits', {
      label: 'API',
      errorMessage: e.message,
      personId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve combined credits.',
    });
  }
});

export default personRoutes;
