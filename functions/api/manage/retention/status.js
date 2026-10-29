import { retentionEndpoint, retentionJSON } from '../../../utils/retentionApi.js';

export const onRequest = retentionEndpoint(['GET'], async (context, service) => {
    const id = new URL(context.request.url).searchParams.get('id');
    if (id === null) return service.getStatus();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
        return retentionJSON({ error: { code: 'invalid_run_id', message: 'Invalid cleanup run ID' } }, 400);
    }
    return { run: await service.getRun(id) };
});
