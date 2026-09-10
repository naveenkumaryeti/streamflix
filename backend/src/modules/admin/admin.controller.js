import asyncHandler from '../../utils/asyncHandler.js';
import AppError from '../../utils/AppError.js';
import * as adminService from './admin.service.js';
import * as mediaService from '../media/media.service.js';

/**
 * Admin controllers stay thin: read the validated request, call one service function, choose a
 * status code. Every rule about what an admin may do lives in the service, so the HTTP layer
 * has nothing to get wrong.
 */
export const dashboard = asyncHandler(async (_req, res) => {
  res.json(await adminService.dashboard());
});

export const options = asyncHandler(async (_req, res) => {
  res.json(await adminService.formOptions());
});

export const listTitles = asyncHandler(async (req, res) => {
  res.json(await adminService.listTitles({ query: req.valid.query }));
});

export const getTitle = asyncHandler(async (req, res) => {
  res.json(await adminService.getTitle(req.valid.params.id));
});

export const createTitle = asyncHandler(async (req, res) => {
  const title = await adminService.createTitle({ payload: req.valid.body, actorId: req.user.id, ip: req.ip });
  res.status(201).json(title);
});

export const updateTitle = asyncHandler(async (req, res) => {
  res.json(
    await adminService.updateTitle({
      id: req.valid.params.id,
      patch: req.valid.body,
      actorId: req.user.id,
      ip: req.ip,
    }),
  );
});

export const publishTitle = asyncHandler(async (req, res) => {
  res.json(await adminService.publishTitle({ id: req.valid.params.id, actorId: req.user.id, ip: req.ip }));
});

export const unpublishTitle = asyncHandler(async (req, res) => {
  res.json(
    await adminService.unpublishTitle({
      id: req.valid.params.id,
      status: req.valid.body?.status ?? 'ready',
      actorId: req.user.id,
      ip: req.ip,
    }),
  );
});

export const deleteTitle = asyncHandler(async (req, res) => {
  res.json(await adminService.deleteTitle({ id: req.valid.params.id, actorId: req.user.id, ip: req.ip }));
});

/* ------------------------------------------------------------------------ media pipeline */

export const uploadTarget = asyncHandler(async (req, res) => {
  const target = await mediaService.createUploadTarget({
    titleId: req.valid.params.id,
    filename: req.valid.body.filename,
    contentType: req.valid.body.contentType,
    actorId: req.user.id,
    ip: req.ip,
  });
  res.status(201).json(target);
});

/**
 * Local-mode receiver for the URL `createUploadTarget` handed out. The request body is piped
 * to storage, so a 4 GB file costs one file descriptor rather than 4 GB of heap.
 */
export const uploadObject = asyncHandler(async (req, res) => {
  const result = await mediaService.acceptUpload({
    key: req.valid.query.key,
    stream: req,
    contentType: req.get('content-type'),
  });
  res.status(201).json(result);
});

export const registerSource = asyncHandler(async (req, res) => {
  const asset = await mediaService.registerSource({
    titleId: req.valid.params.id,
    key: req.valid.body?.key ?? null,
    actorId: req.user.id,
    ip: req.ip,
  });
  res.status(201).json(asset);
});

export const startTranscode = asyncHandler(async (req, res) => {
  const result = await mediaService.startTranscode({
    titleId: req.valid.params.id,
    actorId: req.user.id,
    ip: req.ip,
  });
  // 200 rather than 201 when a job was already running: nothing new was created.
  res.status(result.alreadyRunning ? 200 : 202).json(result);
});

export const media = asyncHandler(async (req, res) => {
  res.json(await mediaService.mediaFor(req.valid.params.id));
});

export const uploadArtwork = asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('Attach an image file in the "file" field', 'FILE_REQUIRED');
  const result = await mediaService.uploadArtwork({
    titleId: req.valid.params.id,
    kind: req.valid.params.kind,
    filename: req.file.originalname,
    body: req.file.buffer,
    contentType: req.file.mimetype,
    actorId: req.user.id,
    ip: req.ip,
  });
  res.status(201).json(result);
});

/* --------------------------------------------------------------------------- people etc. */

export const listUsers = asyncHandler(async (req, res) => {
  res.json(await adminService.listUsers({ query: req.valid.query }));
});

export const setUserStatus = asyncHandler(async (req, res) => {
  res.json(
    await adminService.setUserStatus({
      id: req.valid.params.id,
      status: req.valid.body.status,
      actorId: req.user.id,
      ip: req.ip,
    }),
  );
});

export const setUserRole = asyncHandler(async (req, res) => {
  res.json(
    await adminService.setUserRole({
      id: req.valid.params.id,
      role: req.valid.body.role,
      actorId: req.user.id,
      ip: req.ip,
    }),
  );
});

export const listPayments = asyncHandler(async (req, res) => {
  res.json(await adminService.listPayments({ query: req.valid.query }));
});

export const listAudit = asyncHandler(async (req, res) => {
  res.json(await adminService.listAudit({ query: req.valid.query }));
});
