import { Issuer, custom, HttpOptions, Client, EndSessionParameters } from 'openid-client';
import url, { UrlObject } from 'url';
import urlJoin from 'url-join';
import createDebug from './utils/debug';
import { Config } from './config';

const debug = createDebug('client');

export interface ClientFactory {
  (): Promise<Client>;
}

// @TODO
const pkg = { name: 'some-name', version: 'some-version' };

const telemetryHeader = {
  name: 'nextjs-auth0',
  version: pkg.version,
  env: {
    node: process.version
  }
};

function sortSpaceDelimitedString(str: string) {
  return str.split(' ').sort().join(' ');
}

export default function get(config: Config): ClientFactory {
  let client: Client | null = null;

  return async (): Promise<Client> => {
    if (client) {
      return client;
    }

    const defaultHttpOptions = (options: HttpOptions) => {
      options.headers = {
        ...options.headers,
        'User-Agent': `${pkg.name}/${pkg.version}`,
        ...(config.enableTelemetry
          ? {
              'Auth0-Client': Buffer.from(JSON.stringify(telemetryHeader)).toString('base64')
            }
          : undefined)
      };
      options.timeout = 5000;
      return options;
    };
    const applyHttpOptionsCustom = (entity: Issuer<Client> | typeof Issuer | Client) =>
      (entity[custom.http_options] = defaultHttpOptions);

    applyHttpOptionsCustom(Issuer);
    const issuer = await Issuer.discover(config.issuerBaseURL);
    applyHttpOptionsCustom(issuer);

    const issuerTokenAlgs = Array.isArray(issuer.id_token_signing_alg_values_supported)
      ? issuer.id_token_signing_alg_values_supported
      : [];
    if (!issuerTokenAlgs.includes(config.idTokenSigningAlg)) {
      debug(
        'ID token algorithm %o is not supported by the issuer. Supported ID token algorithms are: %o.',
        config.idTokenSigningAlg,
        issuerTokenAlgs
      );
    }

    const configRespType = sortSpaceDelimitedString(config.authorizationParams.response_type);
    const issuerRespTypes = Array.isArray(issuer.response_types_supported) ? issuer.response_types_supported : [];
    issuerRespTypes.map(sortSpaceDelimitedString);
    if (!issuerRespTypes.includes(configRespType)) {
      debug(
        'Response type %o is not supported by the issuer. ' + 'Supported response types are: %o.',
        configRespType,
        issuerRespTypes
      );
    }

    const configRespMode = config.authorizationParams.response_mode;
    const issuerRespModes = Array.isArray(issuer.response_modes_supported) ? issuer.response_modes_supported : [];
    if (configRespMode && !issuerRespModes.includes(configRespMode)) {
      debug(
        'Response mode %o is not supported by the issuer. ' + 'Supported response modes are %o.',
        configRespMode,
        issuerRespModes
      );
    }

    client = new issuer.Client({
      client_id: config.clientID,
      client_secret: config.clientSecret,
      id_token_signed_response_alg: config.idTokenSigningAlg
    });
    applyHttpOptionsCustom(client);
    client[custom.clock_tolerance] = config.clockTolerance;

    if (config.idpLogout && !issuer.end_session_endpoint) {
      if (config.auth0Logout || url.parse(issuer.metadata.issuer).hostname?.match('\\.auth0\\.com$')) {
        Object.defineProperty(client, 'endSessionUrl', {
          value(params: EndSessionParameters) {
            const parsedUrl = url.parse(urlJoin(issuer.metadata.issuer, '/v2/logout'));
            (parsedUrl as UrlObject).query = {
              returnTo: params.post_logout_redirect_uri,
              client_id: config.clientID
            };
            return url.format(parsedUrl);
          }
        });
      } else {
        debug('the issuer does not support RP-Initiated Logout');
      }
    }

    return client;
  };
}