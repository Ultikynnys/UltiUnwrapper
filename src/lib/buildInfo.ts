type BuildEnv = {
  VITE_BUILD_VERSION?: string;
  VITE_COMMIT_SHA?: string;
};

const env = (import.meta as ImportMeta & { env?: BuildEnv }).env ?? {};

export const BUILD_VERSION = env.VITE_BUILD_VERSION ?? '0.0.0-dev';
export const COMMIT_SHA = env.VITE_COMMIT_SHA ?? 'LOCAL';
export const BUILD_LABEL = `v${BUILD_VERSION} - ${COMMIT_SHA}`;
