import { retentionEndpoint, retentionJSON } from '../../../utils/retentionApi.js';

export const onRequest = retentionEndpoint(['POST'], async (_context, service, body) => {
    if (body.confirmation !== 'DELETE_EXPIRED_FILES' || typeof body.previewToken !== 'string' || !body.previewToken.trim() || body.previewToken.length > 128) {
        return retentionJSON({ error: { code: 'confirmation_required', message: 'Preview and explicitly confirm the files to be deleted' } }, 400);
    }
    return retentionJSON({ run: await service.startManual(body) }, 202);
});
