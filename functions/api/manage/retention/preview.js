import { retentionEndpoint } from '../../../utils/retentionApi.js';

export const onRequest = retentionEndpoint(['POST'], (_context, service) => service.preview());
