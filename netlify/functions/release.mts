import {createRelay} from '../../relay.mjs';
export default createRelay({publishEnabled:Netlify.env.get('ENABLE_SIGNED_FORWARDING') === '1'});
export const config = {path:['/health','/api/v1/code-update/version','/api/v1/code-update/download/:version','/api/v1/signed/code-update/publish']};
