import { handleAddressResolve } from '../_shared/address-core.ts';
import { addressDepsFromEnv } from '../_shared/address-deps.ts';

Deno.serve((req) => handleAddressResolve(req, addressDepsFromEnv(Deno.env)));
