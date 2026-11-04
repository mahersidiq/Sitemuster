import { handleAddressSearch } from '../_shared/address-core.ts';
import { addressDepsFromEnv } from '../_shared/address-deps.ts';

Deno.serve((req) => handleAddressSearch(req, addressDepsFromEnv(Deno.env)));
