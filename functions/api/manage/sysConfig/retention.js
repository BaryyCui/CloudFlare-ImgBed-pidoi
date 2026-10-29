import { retentionEndpoint } from '../../../utils/retentionApi.js';

export const onRequest = retentionEndpoint(['GET', 'POST'], (context, service, body) =>
    context.request.method === 'GET' ? service.getStatus() : service.saveConfig(body));
