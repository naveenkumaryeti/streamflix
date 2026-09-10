import asyncHandler from '../../utils/asyncHandler.js';
import * as catalogService from './catalog.service.js';

const viewer = (req) => req.user?.id ?? null;

export const browse = asyncHandler(async (req, res) => {
  res.json(await catalogService.browse({ userId: viewer(req) }));
});

export const listTitles = asyncHandler(async (req, res) => {
  res.json(await catalogService.listTitles({ query: req.valid.query, userId: viewer(req) }));
});

export const getTitle = asyncHandler(async (req, res) => {
  res.json(await catalogService.getTitleBySlug({ slug: req.valid.params.slug, userId: viewer(req) }));
});

export const search = asyncHandler(async (req, res) => {
  const { q, ...query } = req.valid.query;
  res.json(await catalogService.searchTitles({ q, query, userId: viewer(req) }));
});

export const suggest = asyncHandler(async (req, res) => {
  const { q, limit } = req.valid.query;
  res.json({ items: await catalogService.suggest({ q, limit }) });
});

export const genres = asyncHandler(async (_req, res) => {
  res.json({ items: await catalogService.listGenres() });
});

export const facets = asyncHandler(async (_req, res) => {
  res.json(await catalogService.facets());
});

export const continueWatching = asyncHandler(async (req, res) => {
  res.json({ items: await catalogService.continueWatchingFor(req.user.id) });
});

export const myList = asyncHandler(async (req, res) => {
  res.json(await catalogService.myList({ userId: req.user.id, query: req.valid.query }));
});

export const addToMyList = asyncHandler(async (req, res) => {
  res.status(201).json(await catalogService.addToMyList({ userId: req.user.id, titleId: req.valid.params.titleId }));
});

export const removeFromMyList = asyncHandler(async (req, res) => {
  res.json(await catalogService.removeFromMyList({ userId: req.user.id, titleId: req.valid.params.titleId }));
});
