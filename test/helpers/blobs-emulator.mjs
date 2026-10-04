import {BlobsServer} from '@netlify/blobs/server';

/**
 * Compatibility adapter for the pinned SDK 11.1.3 local emulator only.
 * Its GET omits ETag even though PUT's conditional implementation needs it;
 * its filesystem compare/write also lacks the production service's atomicity.
 * Return the emulator's own exact ETag and serialize its local I/O. The SDK,
 * persisted files, condition validation, and production function stay intact.
 * This helper is never imported by any production module.
 */
export class ConditionalBlobsEmulator extends BlobsServer {
  queue = Promise.resolve();
  handleRequest(request) {
    const pending = this.queue.then(()=>super.handleRequest(request));
    this.queue = pending.catch(()=>{});
    return pending;
  }
  async get(request) {
    const response = await super.get(request);
    const {dataPath,key} = this.getLocalPaths(this.parseAPIRequest(request)?.url ?? new URL(request.url));
    if (response.status===200 && key && !response.headers.has('etag')) {
      const etag = await BlobsServer.generateETag(dataPath);
      if (!etag) throw new Error('Local emulator could not produce an ETag.');
      response.headers.set('etag',etag);
    }
    return response;
  }
}
