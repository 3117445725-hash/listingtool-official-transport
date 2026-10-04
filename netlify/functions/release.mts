import {createRelay} from '../../relay.mjs';
// This deployment was enabled only after actual Windows full13 acceptance (37189321417).
// A platform variable of 0 is an emergency disable; no signing key is stored here.
export default createRelay({publishEnabled:Netlify.env.get('ENABLE_SIGNED_FORWARDING') !== '0'});
export const config = {path:['/health','/api/v1/code-update/version','/api/v1/code-update/download/:version','/api/v1/signed/code-update/publish']};
