{ pkgs }:

let
  src = pkgs.lib.fileset.toSource {
    root = ../frontend;
    fileset = pkgs.lib.fileset.unions [
      ../frontend/index.html
      ../frontend/.gitignore
      ../frontend/package.json
      ../frontend/pnpm-lock.yaml
      ../frontend/src
      ../frontend/tsconfig.json
      ../frontend/vite.config.ts
    ];
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "gitto-frontend";
  version = "0.2.1";
  inherit src;

  # Verify the built assets, not the package manager's internal store format.
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
  outputHash = "sha256-L1+aFIWLcXdWhqnUB9RsXH7GAXZ4s3G+EagZXcSnSCI=";

  nativeBuildInputs = [
    pkgs.nodejs_24
    pkgs.pnpm
    pkgs.cacert
    pkgs.writableTmpDirAsHomeHook
  ];

  impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars;
  env.CI = "true";

  configurePhase = ''
    runHook preConfigure
    export npm_config_manage_package_manager_versions=false
    export pnpm_config_pm_on_fail=ignore
    pnpm install --frozen-lockfile --ignore-scripts
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    export VP_PACKAGE_MANAGER="pnpm@${pkgs.pnpm.version}"
    pnpm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r dist "$out/"
    runHook postInstall
  '';
}
