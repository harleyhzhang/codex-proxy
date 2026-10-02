import { adaptRequest, BackendError } from '../backends/contract';
import { backendFor } from '../backends/registry';
import { responseObject } from '../protocol/output';
import { validateRequest } from '../protocol/prompt';
import { EMPTY_OUTPUT, type ResponseObject, type ResponsesBody } from '../protocol/types';

/**
 * Runs one turn on a subscription backend. Warmups (`generate: false`) are answered locally and
 * never start a billable generation.
 */
export async function localResponse(body: ResponsesBody, signal?: AbortSignal): Promise<ResponseObject> {
  const backend = backendFor(body.model);
  if (!backend) throw new BackendError('Unsupported model');
  const output =
    body.generate === false ? EMPTY_OUTPUT : await backend.run(validateRequest(adaptRequest(body, backend)), signal);
  return responseObject(body, output);
}
