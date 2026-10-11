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
  version = "0.1.0";
  inherit src;

  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "gitto-frontend";
    version = "0.1.0";
    inherit src;
    pnpm = pkgs.pnpm;
    fetcherVersion = 4;
    hash = "sha256-ruIGbUAmm4QjYiZnOD+NxM3loOvcQpVjVjI0RWlKfXU=";
  };

  nativeBuildInputs = [
    pkgs.nodejs_24
    pkgs.pnpm
    pkgs.pnpmConfigHook
  ];

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
