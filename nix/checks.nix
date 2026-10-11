{
  pkgs,
  frontend,
  gitto,
}:

let
  source = pkgs.lib.fileset.toSource {
    root = ../.;
    fileset = pkgs.lib.fileset.unions (
      [
        ../Cargo.lock
        ../Cargo.toml
        ../src
      ]
      ++ pkgs.lib.optional (builtins.pathExists ../README.md) ../README.md
    );
  };

  frontendSource = frontend.src;
  frontendDeps = frontend.pnpmDeps;

  rustClippy = pkgs.rustPlatform.buildRustPackage {
    pname = "gitto-backend-clippy";
    version = "0.1.0";
    src = source;
    cargoLock.lockFile = ../Cargo.lock;

    nativeBuildInputs = [
      pkgs.clippy
      pkgs.cmake
      pkgs.pkg-config
    ];

    preBuild = ''
      mkdir -p frontend/dist
      cp -r ${frontend}/dist/. frontend/dist/
    '';

    doCheck = false;
    buildPhase = ''
      runHook preBuild
      cargo clippy --all-targets --all-features -- -D warnings
      runHook postBuild
    '';
    installPhase = ''
      mkdir -p "$out"
      touch "$out/checked"
    '';
  };

  rustFmt =
    pkgs.runCommand "gitto-backend-fmt"
      {
        nativeBuildInputs = [
          pkgs.cargo
          pkgs.rustfmt
        ];
      }
      ''
        cp -r ${source} source
        chmod -R u+w source
        cd source
        cargo fmt --all -- --check
        touch "$out"
      '';

  pnpmCheck =
    name: script:
    pkgs.stdenvNoCC.mkDerivation {
      pname = "gitto-frontend-${name}";
      version = "0.1.0";
      src = frontendSource;
      pnpmDeps = frontendDeps;
      nativeBuildInputs = [
        pkgs.nodejs_24
        pkgs.pnpm
        pkgs.pnpmConfigHook
      ];
      buildPhase = ''
        runHook preBuild
        export VP_PACKAGE_MANAGER="pnpm@${pkgs.pnpm.version}"
        pnpm run ${script}
        runHook postBuild
      '';
      installPhase = ''
        mkdir -p "$out"
        touch "$out/checked"
      '';
    };

in
{
  backend-tests = gitto;
  backend-clippy = rustClippy;
  backend-fmt = rustFmt;
  frontend-tests = pnpmCheck "tests" "test";
  frontend-format = pnpmCheck "format" "format:check";
  frontend-check = pnpmCheck "check" "check";
  frontend-build = frontend;
  inherit gitto;
}
